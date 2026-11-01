// Delivery claim registry: one registry per physical repository, resolved
// through the Git common directory so the main checkout and all linked
// worktrees share <git-common-dir>/squad/run/. Coordination is a short-lived
// atomic `mkdir` mutex — never time-stolen, no automatic stale reclaim.
// Malformed, corrupt, unknown-version, or foreign registry content always
// fails closed as BLOCKED.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { normalizeScope } from './delivery-scope.mjs';
import { mainWorktreeRoot } from './delivery-worktree.mjs';

const execFileP = promisify(execFile);

export const REGISTRY_LIMITS = {
  maxRecordBytes: 64 * 1024,
  maxRecords: 1000,
  maxScopeEntries: 256,
  maxPathChars: 4096,
  maxReferenceChars: 512,
  maxIdChars: 80,
};

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RECORD_FILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;
const SHA_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const ISO_UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;
const STATES = new Set(['PREPARING', 'ACTIVE', 'RECOVERY_REQUIRED', 'RELEASED']);
const LOCK_DIR = '.lock';
const LOCK_OWNER_FILE = 'owner';
const RECORD_FIELDS = new Set([
  'schemaVersion',
  'deliveryId',
  'ownerToken',
  'generation',
  'state',
  'repositoryRoot',
  'branch',
  'worktreePath',
  'baseRef',
  'baseCommit',
  'scope',
  'createdAt',
  'heartbeatAt',
  'approval',
  'stoppedConfirmation',
  'stoppedConfirmedAt',
  'releasedAt',
  'failure',
]);
const REQUIRED_FIELDS = [
  'schemaVersion',
  'deliveryId',
  'ownerToken',
  'generation',
  'state',
  'repositoryRoot',
  'branch',
  'worktreePath',
  'baseRef',
  'baseCommit',
  'scope',
  'createdAt',
  'heartbeatAt',
  'approval',
];

const ok = (extra = {}) => ({ status: 'OK', code: 'OK', ...extra });
const blocked = (code, extra = {}) => ({ status: 'BLOCKED', code, ...extra });
const error = (code, message) => ({ status: 'ERROR', code, message });

class Blocked extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function gitOut(repositoryPath, args) {
  const { stdout } = await execFileP('git', ['-C', repositoryPath, ...args]);
  return stdout.trim();
}

async function resolveRepository(repositoryPath) {
  if (typeof repositoryPath !== 'string' || !path.isAbsolute(repositoryPath)) {
    throw new Blocked('INVALID_INPUT');
  }
  let commonDirOut;
  let rootOut;
  try {
    commonDirOut = await gitOut(repositoryPath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    rootOut = await gitOut(repositoryPath, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Blocked('INVALID_INPUT');
  }
  const commonDir = await fs.realpath(commonDirOut);
  const repositoryRoot = await fs.realpath(rootOut);
  return { repositoryRoot, commonDir, registryPath: path.join(commonDir, 'squad', 'run') };
}

// Registry control paths must be plain directories (or absent). lstat is
// used directly so dangling symlinks cannot slip past an existsSync check.
function assertControlDir(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Blocked('RECOVERY_REQUIRED');
    return; // absent is fine — the directory will be created when needed
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Blocked('RECOVERY_REQUIRED');
  }
}

function isEvidence(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.confirmed === true &&
    typeof value.reference === 'string' &&
    value.reference.length >= 1 &&
    value.reference.length <= REGISTRY_LIMITS.maxReferenceChars &&
    Object.keys(value).every((k) => k === 'confirmed' || k === 'reference')
  );
}

// Strict UTC ISO validation: components must round-trip through Date.UTC so
// auto-normalizing dates like 2025-02-31 are rejected.
function isIsoUtc(value) {
  if (typeof value !== 'string') return false;
  const m = ISO_UTC_PATTERN.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
  return (
    t.getUTCFullYear() === +y &&
    t.getUTCMonth() === +mo - 1 &&
    t.getUTCDate() === +d &&
    t.getUTCHours() === +h &&
    t.getUTCMinutes() === +mi &&
    t.getUTCSeconds() === +s
  );
}

// Manual validation following delivery-session.schema.json exactly; no
// schema compiler and no code execution from records.
export function validateClaimRecord(record) {
  const errs = [];
  const fail = (msg) => errs.push(msg);
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return ['record is not an object'];
  }
  for (const key of Object.keys(record)) {
    if (!RECORD_FIELDS.has(key)) fail(`unknown field ${key}`);
  }
  for (const key of REQUIRED_FIELDS) {
    if (!(key in record)) fail(`missing required field ${key}`);
  }
  if (errs.length > 0) return errs;
  if (record.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (
    typeof record.deliveryId !== 'string' ||
    record.deliveryId.length > REGISTRY_LIMITS.maxIdChars ||
    !ID_PATTERN.test(record.deliveryId)
  ) {
    fail('deliveryId must match kebab pattern within 80 chars');
  }
  if (typeof record.ownerToken !== 'string' || record.ownerToken.length === 0) {
    fail('ownerToken must be a non-empty string');
  }
  if (
    !Number.isSafeInteger(record.generation) ||
    record.generation < 1
  ) {
    fail('generation must be a positive safe integer');
  }
  if (!STATES.has(record.state)) fail('state must be a known lifecycle state');
  for (const key of ['repositoryRoot', 'worktreePath']) {
    if (
      typeof record[key] !== 'string' ||
      !path.isAbsolute(record[key]) ||
      path.resolve(record[key]) !== record[key] ||
      record[key].length > REGISTRY_LIMITS.maxPathChars
    ) {
      fail(`${key} must be a canonical absolute path within ${REGISTRY_LIMITS.maxPathChars} chars`);
    }
  }
  for (const key of ['branch', 'baseRef']) {
    if (typeof record[key] !== 'string' || record[key].length === 0 || record[key].length > 256) {
      fail(`${key} must be a non-empty string within 256 chars`);
    }
  }
  // Path/branch binding: a claim is pinned to its own squad branch and its
  // own worktree under the recorded main checkout.
  if (typeof record.branch === 'string' && typeof record.deliveryId === 'string') {
    if (record.branch !== `squad/${record.deliveryId}`) {
      fail('branch must be squad/<deliveryId>');
    }
  }
  if (
    typeof record.repositoryRoot === 'string' &&
    path.isAbsolute(record.repositoryRoot) &&
    path.resolve(record.repositoryRoot) === record.repositoryRoot &&
    typeof record.deliveryId === 'string' &&
    ID_PATTERN.test(record.deliveryId) &&
    record.worktreePath !==
      path.join(record.repositoryRoot, '.squad', 'worktrees', record.deliveryId)
  ) {
    fail('worktreePath must be <repositoryRoot>/.squad/worktrees/<deliveryId>');
  }
  if (typeof record.baseCommit !== 'string' || !SHA_PATTERN.test(record.baseCommit)) {
    fail('baseCommit must be a SHA-1 or SHA-256 hex');
  }
  if (
    !Array.isArray(record.scope) ||
    record.scope.length > REGISTRY_LIMITS.maxScopeEntries ||
    record.scope.some(
      (s) => typeof s !== 'string' || s.length === 0 || s.length > REGISTRY_LIMITS.maxPathChars,
    )
  ) {
    fail(`scope must be an array of up to ${REGISTRY_LIMITS.maxScopeEntries} path strings`);
  } else {
    try {
      normalizeScope(record.scope);
    } catch {
      fail('scope entries must be canonical literal file/tree/root paths');
    }
  }
  for (const key of ['createdAt', 'heartbeatAt']) {
    if (!isIsoUtc(record[key])) fail(`${key} must be a strict UTC ISO timestamp`);
  }
  for (const key of ['stoppedConfirmedAt', 'releasedAt']) {
    if (key in record && !isIsoUtc(record[key])) fail(`${key} must be a strict UTC ISO timestamp`);
  }
  if (!isEvidence(record.approval)) fail('approval must be a {confirmed:true, reference} evidence');
  if ('stoppedConfirmation' in record && !isEvidence(record.stoppedConfirmation)) {
    fail('stoppedConfirmation must be a {confirmed:true, reference} evidence');
  }
  if ('failure' in record) {
    const f = record.failure;
    if (
      f === null ||
      typeof f !== 'object' ||
      typeof f.reason !== 'string' ||
      f.reason.length === 0 ||
      f.reason.length > 1024 ||
      !Object.keys(f).every((k) => k === 'reason')
    ) {
      fail('failure must be {reason: string <=1024}');
    }
  }
  if (record.state === 'RELEASED') {
    for (const key of ['stoppedConfirmation', 'stoppedConfirmedAt', 'releasedAt']) {
      if (!(key in record)) fail(`RELEASED record requires ${key}`);
    }
  }
  return errs;
}

function sanitizeRecord(record) {
  const out = { ...record };
  delete out.ownerToken;
  if (out.approval) out.approval = { reference: out.approval.reference };
  if (out.stoppedConfirmation) {
    out.stoppedConfirmation = { reference: out.stoppedConfirmation.reference };
  }
  return out;
}

// Reads and validates every record file. expectedOwner, when given, is the
// nonce of the caller-held mutex so our own .lock directory is tolerated.
// Throws Blocked('RECOVERY_REQUIRED') on any suspicious state.
async function readRawRecords(registryPath, expectedOwner = null) {
  let dirents;
  try {
    dirents = await fs.readdir(registryPath, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    if (err.code === 'ENOTDIR') throw new Blocked('RECOVERY_REQUIRED');
    throw err;
  }
  const recordFiles = [];
  for (const dirent of dirents) {
    if (dirent.name === LOCK_DIR) {
      if (expectedOwner === null || !dirent.isDirectory()) throw new Blocked('RECOVERY_REQUIRED');
      let owner;
      try {
        owner = await fs.readFile(path.join(registryPath, LOCK_DIR, LOCK_OWNER_FILE), 'utf8');
      } catch {
        throw new Blocked('RECOVERY_REQUIRED');
      }
      if (owner !== expectedOwner) throw new Blocked('RECOVERY_REQUIRED');
      continue;
    }
    if (!RECORD_FILE_PATTERN.test(dirent.name) || !dirent.isFile() || dirent.isSymbolicLink()) {
      throw new Blocked('RECOVERY_REQUIRED');
    }
    recordFiles.push(dirent.name);
  }
  if (recordFiles.length > REGISTRY_LIMITS.maxRecords) throw new Blocked('RECOVERY_REQUIRED');
  const records = [];
  for (const name of recordFiles) {
    const full = path.join(registryPath, name);
    const stat = await fs.stat(full);
    if (stat.size > REGISTRY_LIMITS.maxRecordBytes) throw new Blocked('RECOVERY_REQUIRED');
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(full, 'utf8'));
    } catch {
      throw new Blocked('RECOVERY_REQUIRED');
    }
    if (validateClaimRecord(parsed).length > 0) throw new Blocked('RECOVERY_REQUIRED');
    // The record filename is the claim's identity; a mismatched body could
    // otherwise hide a duplicate claim under an alias name.
    if (parsed.deliveryId !== name.slice(0, -'.json'.length)) {
      throw new Blocked('RECOVERY_REQUIRED');
    }
    records.push(parsed);
  }
  return records;
}

export async function readRegistry({ repositoryPath } = {}) {
  try {
    const { repositoryRoot, commonDir, registryPath } = await resolveRepository(repositoryPath);
    assertControlDir(path.join(commonDir, 'squad'));
    assertControlDir(registryPath);
    const records = await readRawRecords(registryPath);
    return ok({
      records: records.map(sanitizeRecord),
      repositoryRoot,
      commonDir,
      registryPath,
    });
  } catch (err) {
    if (err instanceof Blocked) {
      return err.code === 'INVALID_INPUT'
        ? error('INVALID_INPUT', 'repositoryPath is not a Git checkout')
        : blocked('RECOVERY_REQUIRED');
    }
    return error('RECOVERY_REQUIRED', String(err.message || err));
  }
}

// Read-only ownership check for the write verifier: resolves the claim
// privately, validates token + generation + ACTIVE against raw records, and
// returns the sanitized claim. Never acquires the mutex, never writes, and
// never exposes the raw token.
export async function readOwnedClaim({ repositoryPath, deliveryId, ownerToken, generation } = {}) {
  try {
    if (
      typeof repositoryPath !== 'string' ||
      typeof deliveryId !== 'string' ||
      !ID_PATTERN.test(deliveryId) ||
      deliveryId.length > REGISTRY_LIMITS.maxIdChars ||
      typeof ownerToken !== 'string' ||
      ownerToken.length === 0 ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      return error('INVALID_INPUT', 'invalid ownership context');
    }
    const { repositoryRoot, commonDir, registryPath } = await resolveRepository(repositoryPath);
    assertControlDir(path.join(commonDir, 'squad'));
    assertControlDir(registryPath);
    const records = await readRawRecords(registryPath);
    const rec = records.find((r) => r.deliveryId === deliveryId);
    if (
      !rec ||
      rec.state !== 'ACTIVE' ||
      rec.ownerToken !== ownerToken ||
      rec.generation !== generation
    ) {
      return blocked('OWNER_MISMATCH', 'stale owner token, generation, or state');
    }
    if (rec.repositoryRoot !== await mainWorktreeRoot(repositoryPath)) {
      return blocked('RECOVERY_REQUIRED', { message: 'claim is bound to a different main checkout' });
    }
    return ok({ record: sanitizeRecord(rec), repositoryRoot, commonDir, registryPath });
  } catch (err) {
    if (err instanceof Blocked) {
      return err.code === 'INVALID_INPUT'
        ? error('INVALID_INPUT', 'repositoryPath is not a Git checkout')
        : blocked('RECOVERY_REQUIRED');
    }
    return error('RECOVERY_REQUIRED', String(err.message || err));
  }
}

export async function withRegistryLock({ repositoryPath, approval } = {}, operation) {
  if (!isEvidence(approval)) {
    return blocked('APPROVAL_REQUIRED');
  }
  if (typeof operation !== 'function') {
    return error('INVALID_INPUT', 'operation must be a function');
  }
  let resolved;
  try {
    resolved = await resolveRepository(repositoryPath);
  } catch (err) {
    if (err instanceof Blocked) {
      return err.code === 'INVALID_INPUT' ? error('INVALID_INPUT', 'not a Git checkout') : blocked(err.code);
    }
    return error('RECOVERY_REQUIRED', String(err.message || err));
  }
  const { repositoryRoot, commonDir, registryPath } = resolved;
  const lockPath = path.join(registryPath, LOCK_DIR);
  const nonce = randomUUID();
  let result;
  let callbackError;
  let registryError;
  let lockHeld = false;
  // Returns true only when our own mutex was verified and removed. A
  // foreign or missing marker is preserved untouched.
  const releaseOwnLock = async () => {
    try {
      const owner = await fs.readFile(path.join(lockPath, LOCK_OWNER_FILE), 'utf8');
      if (owner !== nonce) return false; // never remove a foreign mutex
      await fs.unlink(path.join(lockPath, LOCK_OWNER_FILE));
      await fs.rmdir(lockPath);
      lockHeld = false;
      return true;
    } catch {
      // Leftover lock blocks conservatively until manual inspected recovery.
      return false;
    }
  };
  const writeRecord = async (record) => {
    let owner;
    try {
      owner = await fs.readFile(path.join(lockPath, LOCK_OWNER_FILE), 'utf8');
    } catch {
      owner = null;
    }
    if (owner !== nonce) return blocked('OWNER_MISMATCH');
    const errs = validateClaimRecord(record);
    if (errs.length > 0) return error('INVALID_INPUT', errs.join('; '));
    const data = JSON.stringify(record, null, 2);
    if (Buffer.byteLength(data, 'utf8') > REGISTRY_LIMITS.maxRecordBytes) {
      return error('INVALID_INPUT', 'record exceeds 64 KiB');
    }
    const current = await readRawRecords(registryPath, nonce);
    const target = path.join(registryPath, `${record.deliveryId}.json`);
    const isNew = !existsSync(target);
    if (isNew && current.length >= REGISTRY_LIMITS.maxRecords) {
      return error('INVALID_INPUT', 'record count exceeds limit');
    }
    try {
      if (lstatSync(target).isSymbolicLink()) {
        return error('INVALID_INPUT', 'record target is a symlink');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') return error('RECOVERY_REQUIRED', String(err.message || err));
      // ENOENT: new record file
    }
    const tmp = `${target}.${nonce}.tmp`;
    try {
      await fs.writeFile(tmp, data, { flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') return error('INVALID_INPUT', 'temp file collision');
      throw err;
    }
    await fs.rename(tmp, target);
    return ok();
  };
  try {
    assertControlDir(path.join(commonDir, 'squad'));
    assertControlDir(registryPath);
    await fs.mkdir(registryPath, { recursive: true });
    try {
      await fs.mkdir(lockPath);
    } catch (err) {
      // A held (or crash-left) mutex is transient contention, not a registry
      // anomaly — flagged so callers holding a claim can retry the lock
      // acquisition itself instead of reporting retained-claim recovery.
      if (err.code === 'EEXIST') {
        return blocked('RECOVERY_REQUIRED', { contended: true });
      }
      throw err;
    }
    lockHeld = true;
    await fs.writeFile(path.join(lockPath, LOCK_OWNER_FILE), nonce);
    let records;
    try {
      records = await readRawRecords(registryPath, nonce);
    } catch (err) {
      registryError = err;
    }
    if (registryError === undefined) {
      try {
        result = await operation({
          records,
          writeRecord,
          repositoryRoot,
          commonDir,
          registryPath,
        });
      } catch (err) {
        callbackError = err;
      }
    }
  } catch (err) {
    if (err instanceof Blocked) return blocked(err.code);
    return error('RECOVERY_REQUIRED', String(err.message || err));
  }
  const released = lockHeld ? await releaseOwnLock() : true;
  // The operation's own failure propagates honestly after the mutex is
  // released; it is never rewritten as a registry result.
  if (callbackError !== undefined) throw callbackError;
  if (registryError !== undefined) {
    if (registryError instanceof Blocked) return blocked(registryError.code);
    return error('RECOVERY_REQUIRED', String(registryError.message || registryError));
  }
  // If our mutex could not be released or its ownership changed underneath
  // us, the operation must not report success. The foreign marker stays.
  if (!released) return blocked('OWNER_MISMATCH');
  return result;
}
