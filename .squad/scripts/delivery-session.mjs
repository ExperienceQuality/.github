// Concurrent-delivery session orchestration — T4/T5 lifecycle.
// runSessionCommand(command, request) implements the six protocol commands:
// status | acquire | extend | heartbeat | resume | release. Every mutation
// runs inside the registry mutex and produces atomic claim writes.
//
// CLI: node .squad/scripts/delivery-session.mjs <command>
//   stdin:  one JSON request (empty allowed for status), <= 64 KiB
//   stdout: one JSON result   exit: 0 OK / 2 BLOCKED / 1 ERROR
//   stderr: human diagnostics only

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { existsSync, lstatSync, realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  normalizeScope,
  findScopeConflicts,
  parseScopeEntry,
  comparisonKey,
} from './delivery-scope.mjs';
import {
  readRegistry,
  withRegistryLock,
  validateClaimRecord,
  REGISTRY_LIMITS,
} from './delivery-registry.mjs';
import {
  gitOut,
  gitTry,
  gitBlob,
  resolveRepository,
  mainWorktreeRoot,
  resolveCommit,
  branchExists,
  findBaseSymlinkAlias,
  findWorktreeSymlink,
  checkWorktreePathChain,
  checkExcludeShape,
  ensureExcludeLine,
} from './delivery-worktree.mjs';

const REQUEST_LIMIT = 64 * 1024;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HELPER_MAP = [
  ['.squad/scripts/delivery-scope.mjs', new URL('./delivery-scope.mjs', import.meta.url)],
  ['.squad/scripts/delivery-registry.mjs', new URL('./delivery-registry.mjs', import.meta.url)],
  ['.squad/scripts/delivery-worktree.mjs', new URL('./delivery-worktree.mjs', import.meta.url)],
  ['.squad/scripts/delivery-session.mjs', new URL('./delivery-session.mjs', import.meta.url)],
  ['.squad/scripts/delivery-verify.mjs', new URL('./delivery-verify.mjs', import.meta.url)],
  [
    '.squad/schemas/delivery-session.schema.json',
    new URL('../schemas/delivery-session.schema.json', import.meta.url),
  ],
];
const BASE_REF_MAX = 256;
const NODE_MIN_MAJOR = 20;
// Bounded in-helper retry for mutex acquisition only where the caller cannot
// retry the command: after a claim exists, a racing acquire retry would hit
// SCOPE_CONFLICT on its own id/branch rather than re-entering activation.
const ACTIVATION_LOCK_ATTEMPTS = 40;
const ACTIVATION_LOCK_DELAY_MS = 20;

function ok(extra = {}) {
  return { status: 'OK', code: 'OK', ...extra };
}

function fail(code, message, extra = {}) {
  return { status: 'ERROR', code, ...(message ? { message } : {}), ...extra };
}

function blocked(code, message, extra = {}) {
  return { status: 'BLOCKED', code, ...(message ? { message } : {}), ...extra };
}

function isEvidence(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !keys.includes('confirmed') || !keys.includes('reference')) {
    return false;
  }
  return (
    v.confirmed === true &&
    typeof v.reference === 'string' &&
    v.reference.length >= 1 &&
    v.reference.length <= REGISTRY_LIMITS.maxReferenceChars
  );
}

function isoNow() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- git helpers live in delivery-worktree.mjs ----------

// Every delivered helper must exist in the base tree as a plain blob whose
// bytes match the currently executing installed helpers — a same-named file
// with incompatible content (or a symlink/dir) is not compatible.
async function findIncompatibleHelper(cwd, baseCommit) {
  for (const [rel, localUrl] of HELPER_MAP) {
    const out = await gitTry(cwd, ['ls-tree', '-z', baseCommit, '--', rel]);
    const line = out && out.split('\0')[0];
    const m = line && line.match(/^(\d+) (\w+) [0-9a-f]+\t.+$/);
    if (!m || m[1] !== '100644' || m[2] !== 'blob') return rel;
    const blob = await gitBlob(cwd, `${baseCommit}:${rel}`);
    let localBytes;
    try {
      localBytes = readFileSync(fileURLToPath(localUrl));
    } catch {
      return rel;
    }
    if (!blob || !blob.equals(localBytes)) return rel;
  }
  return null;
}

// ---------- scope helpers ----------

function memoryPathFor(deliveryId) {
  return ['.squad', 'memory', 'deliveries', `${deliveryId}.ndjson`];
}

function entryCovers(entry, segs) {
  if (entry === '.') return true;
  const parsed = parseScopeEntry(entry);
  if (!parsed) return false;
  const within = parsed.isTree ? parsed.segs.length <= segs.length : parsed.segs.length === segs.length;
  return within && parsed.segs.every((s, i) => comparisonKey(s) === comparisonKey(segs[i]));
}

function scopeCovers(scope, segs) {
  return scope.some((entry) => entryCovers(entry, segs));
}

// ---------- request validation ----------

const EVIDENCE_FIELDS = { approval: 'evidence', stoppedConfirmation: 'evidence' };
const FIELD_SPECS = {
  status: { repositoryPath: 'path?' },
  acquire: {
    repositoryPath: 'path?',
    deliveryId: 'id',
    mainCheckoutPath: 'abspath',
    baseRef: 'gitref',
    scope: 'scope',
    approval: 'evidence',
  },
  extend: {
    repositoryPath: 'path?',
    deliveryId: 'id',
    ownerToken: 'token',
    generation: 'gen',
    scope: 'scope',
    approval: 'evidence',
  },
  heartbeat: { repositoryPath: 'path?', deliveryId: 'id', ownerToken: 'token', generation: 'gen' },
  resume: { repositoryPath: 'path?', deliveryId: 'id', expectedGeneration: 'gen', ...EVIDENCE_FIELDS },
  release: { repositoryPath: 'path?', deliveryId: 'id', expectedGeneration: 'gen', ...EVIDENCE_FIELDS },
};

function checkType(value, kind) {
  switch (kind) {
    case 'path?':
      return typeof value === 'string' && value.length > 0;
    case 'abspath':
      return typeof value === 'string' && path.isAbsolute(value);
    case 'id':
      return typeof value === 'string' && value.length <= 80 && ID_PATTERN.test(value);
    case 'gitref':
      return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= BASE_REF_MAX &&
        !value.startsWith('-') &&
        !/[\r\n]/.test(value)
      );
    case 'scope':
      return (
        Array.isArray(value) &&
        value.length >= 1 &&
        value.length <= REGISTRY_LIMITS.maxScopeEntries &&
        value.every(
          (s) => typeof s === 'string' && s.length <= REGISTRY_LIMITS.maxPathChars,
        )
      );
    case 'token':
      return typeof value === 'string' && value.length > 0;
    case 'gen':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
    case 'evidence':
      return true; // evidence presence/shape is an authorization gate, checked separately
    default:
      return false;
  }
}

function validateRequest(command, request) {
  if (!Object.hasOwn(FIELD_SPECS, command)) {
    return { error: fail('INVALID_INPUT', `unknown command ${command}`) };
  }
  const spec = FIELD_SPECS[command];
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { error: fail('INVALID_INPUT', 'request must be a JSON object') };
  }
  for (const key of Object.keys(request)) {
    if (!Object.hasOwn(spec, key)) {
      return { error: fail('INVALID_INPUT', `unknown field ${key}`) };
    }
  }
  const params = {};
  for (const [key, kind] of Object.entries(spec)) {
    const value = request[key];
    if (value === undefined) {
      // Only an absent field gets the default; an explicit null is invalid.
      if (!kind.endsWith('?') && kind !== 'evidence') {
        return { error: fail('INVALID_INPUT', `missing required field ${key}`) };
      }
      continue;
    }
    if (!checkType(value, kind)) {
      return { error: fail('INVALID_INPUT', `invalid field ${key}`) };
    }
    params[key] = value;
  }
  params.repositoryPath = params.repositoryPath
    ? path.resolve(params.repositoryPath)
    : process.cwd();
  return { params };
}

function requireEvidence(params, ...names) {
  for (const name of names) {
    if (!isEvidence(params[name])) {
      return blocked('APPROVAL_REQUIRED', `${name} evidence is required`);
    }
  }
  return null;
}

function normalizeScopeOrError(scope) {
  try {
    return normalizeScope(scope);
  } catch (err) {
    return { error: fail('INVALID_INPUT', `invalid scope: ${err.message}`) };
  }
}

// ---------- shared claim checks (inside the mutex) ----------

function checkClaimsFor(records, deliveryId, scope, mainRoot) {
  for (const rec of records) {
    if (rec.repositoryRoot !== mainRoot) {
      return blocked(
        'RECOVERY_REQUIRED',
        `claim ${rec.deliveryId} is bound to a different main checkout`,
      );
    }
  }
  for (const rec of records) {
    if (rec.state === 'RELEASED') continue;
    if (rec.deliveryId === deliveryId) continue;
    const conflicts = findScopeConflicts(rec.scope, scope);
    if (conflicts.length) {
      return blocked('SCOPE_CONFLICT', `overlaps claim ${rec.deliveryId}`, {
        conflicts,
        conflictingDeliveryId: rec.deliveryId,
      });
    }
  }
  return null;
}

// ---------- commands ----------

async function cmdStatus(params) {
  return readRegistry({ repositoryPath: params.repositoryPath });
}

async function cmdAcquire(params) {
  const approvalErr = requireEvidence(params, 'approval');
  if (approvalErr) return approvalErr;

  const scope = normalizeScopeOrError(params.scope);
  if (scope.error) return scope.error;
  if (!scopeCovers(scope, memoryPathFor(params.deliveryId))) {
    return fail(
      'INVALID_INPUT',
      'scope must declare the delivery memory file or an encompassing tree/root',
    );
  }
  if (Number(process.versions.node.split('.')[0]) < NODE_MIN_MAJOR) {
    return blocked('RECOVERY_REQUIRED', `node >= ${NODE_MIN_MAJOR} required`);
  }

  let repo;
  try {
    repo = await resolveRepository(params.repositoryPath);
  } catch {
    return fail('INVALID_INPUT', 'repositoryPath is not inside a Git repository');
  }

  // Fail-closed registry gate before any mutation.
  const registryState = await readRegistry({ repositoryPath: params.repositoryPath });
  if (registryState.status !== 'OK') return registryState;

  // Caller-supplied main checkout must genuinely be the main Git worktree for
  // the same common dir.
  let mainRoot;
  try {
    mainRoot = await mainWorktreeRoot(params.repositoryPath);
  } catch {
    return fail('INVALID_INPUT', 'cannot list Git worktrees');
  }
  let claimedMain;
  try {
    claimedMain = realpathSync(params.mainCheckoutPath);
  } catch {
    return fail('INVALID_INPUT', 'mainCheckoutPath does not exist');
  }
  if (!mainRoot || claimedMain !== mainRoot) {
    return blocked('INVALID_INPUT', 'mainCheckoutPath is not the main Git worktree');
  }
  const mainCommon = await gitTry(mainRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!mainCommon || realpathSync(mainCommon.trim()) !== repo.commonDir) {
    return blocked('INVALID_INPUT', 'main checkout belongs to a different repository');
  }

  const baseCommit = await resolveCommit(mainRoot, params.baseRef);
  if (!baseCommit) {
    return blocked('INVALID_INPUT', `baseRef ${params.baseRef} does not resolve to a commit`);
  }

  // The delivered helpers must exist in the base commit as plain blobs with
  // bytes identical to the executing installation — same-named incompatible
  // files cannot run this protocol.
  const incompatible = await findIncompatibleHelper(mainRoot, baseCommit);
  if (incompatible) {
    return blocked('RECOVERY_REQUIRED', `base commit helper is missing or incompatible: ${incompatible}`);
  }

  // Lexical aliases: a claimed path that is/contains a symlink in the base
  // tree could collide with a differently-named claim.
  const alias = await findBaseSymlinkAlias(mainRoot, baseCommit, scope);
  if (alias) {
    return blocked('SCOPE_CONFLICT', `scope entry ${alias} is or contains a symlink alias`);
  }

  // Filesystem preflight on the main checkout.
  const worktreePath = path.join(mainRoot, '.squad', 'worktrees', params.deliveryId);
  const chain = checkWorktreePathChain(mainRoot, params.deliveryId);
  if (chain === 'exists') {
    return blocked('SCOPE_CONFLICT', `worktree path already exists: ${worktreePath}`);
  }
  if (chain === 'invalid') {
    return blocked('RECOVERY_REQUIRED', 'worktree path ancestor is a symlink or non-directory');
  }
  const branch = `squad/${params.deliveryId}`;
  if (await branchExists(mainRoot, branch)) {
    return blocked('SCOPE_CONFLICT', `branch ${branch} already exists`);
  }
  // Exclude metadata shape is preflighted here; the append itself runs under
  // the mutex after the claim is written.
  const excludeShape = checkExcludeShape(repo.commonDir);
  if (excludeShape) return excludeShape;

  const ownerToken = randomUUID();
  const now = isoNow();
  const record = {
    schemaVersion: 1,
    deliveryId: params.deliveryId,
    ownerToken,
    generation: 1,
    state: 'PREPARING',
    repositoryRoot: mainRoot,
    branch,
    worktreePath,
    baseRef: params.baseRef,
    baseCommit,
    scope,
    createdAt: now,
    heartbeatAt: now,
    approval: params.approval,
  };

  // The complete claim must pass record validation before any mutation —
  // a malformed claim can never reach the registry, exclude, or Git.
  const claimErrors = validateClaimRecord(record);
  if (claimErrors.length) {
    return fail('INVALID_INPUT', `claim failed validation: ${claimErrors[0]}`);
  }

  // Reservation: collision recheck + conflict check + PREPARING claim +
  // exclude append, all under one mutex so a racing acquire cannot
  // interleave. The claim is written first so any later failure still has
  // an owner record explaining the created metadata.
  const reservation = await withRegistryLock(
    { repositoryPath: params.repositoryPath, approval: params.approval },
    async (ctx) => {
      if (await branchExists(mainRoot, branch)) {
        return blocked('SCOPE_CONFLICT', `branch ${branch} appeared during reservation`);
      }
      let targetSt;
      try {
        targetSt = lstatSync(worktreePath);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          return blocked('RECOVERY_REQUIRED', `cannot inspect worktree path: ${err.message}`);
        }
        targetSt = null;
      }
      if (targetSt) {
        return blocked('SCOPE_CONFLICT', `worktree path appeared during reservation`);
      }
      const chainNow = checkWorktreePathChain(mainRoot, params.deliveryId);
      if (chainNow) {
        return blocked('RECOVERY_REQUIRED', 'worktree path ancestor changed during reservation');
      }
      const claims = checkClaimsFor(ctx.records, params.deliveryId, scope, mainRoot);
      if (claims) return claims;
      if (ctx.records.some((r) => r.deliveryId === params.deliveryId)) {
        return blocked('SCOPE_CONFLICT', `delivery id ${params.deliveryId} is already claimed`);
      }
      const write = await ctx.writeRecord(record);
      if (write.status !== 'OK') return write;
      const excludeErr = await ensureExcludeLine(ctx.commonDir);
      if (excludeErr) {
        return {
          ...excludeErr,
          deliveryId: params.deliveryId,
          recoveryRequired: true,
        };
      }
      return ok();
    },
  );
  if (reservation.status !== 'OK') return reservation;

  // Provisioning runs outside the mutex; a failure retains the reservation.
  try {
    await gitOut(mainRoot, [
      '-c',
      'core.hooksPath=/dev/null',
      'worktree',
      'add',
      '-b',
      branch,
      worktreePath,
      baseCommit,
    ]);
  } catch {
    await markRecovery(params.repositoryPath, params.approval, record, 'git worktree add failed');
    return blocked(
      'RECOVERY_REQUIRED',
      `worktree provisioning failed; claim ${params.deliveryId} is retained — inspect, then resume after stopping with confirmation`,
      { deliveryId: params.deliveryId, recoveryRequired: true },
    );
  }

  // Activation under a fresh mutex: own PREPARING claim + verified worktree.
  // Mutex contention here is as transient as the reservation's, but the
  // caller cannot retry acquire once a claim exists — so the lock attempt
  // itself retries briefly before reporting retained-claim recovery.
  let activation;
  for (let attempt = 0; ; attempt += 1) {
    activation = await withRegistryLock(
      { repositoryPath: params.repositoryPath, approval: params.approval },
      async (ctx) => {
        const rec = ctx.records.find(
          (r) =>
            r.deliveryId === params.deliveryId &&
            r.ownerToken === ownerToken &&
            r.generation === 1,
        );
        if (!rec || rec.state !== 'PREPARING') {
          return blocked('RECOVERY_REQUIRED', 'claim state changed during provisioning');
        }
        const wtCommon = await gitTry(worktreePath, [
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ]);
        const wtBranch = await gitTry(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (
          !wtCommon ||
          realpathSync(wtCommon.trim()) !== ctx.commonDir ||
          (wtBranch || '').trim() !== branch ||
          !existsSync(path.join(worktreePath, '.squad/scripts/delivery-session.mjs'))
        ) {
          const write = await ctx.writeRecord({
            ...record,
            state: 'RECOVERY_REQUIRED',
            failure: { reason: 'provisioned worktree failed verification' },
          });
          if (write.status !== 'OK') return write;
          return blocked('RECOVERY_REQUIRED', 'provisioned worktree failed verification; claim retained');
        }
        const write = await ctx.writeRecord({
          ...record,
          state: 'ACTIVE',
          heartbeatAt: isoNow(),
        });
        if (write.status !== 'OK') return write;
        return ok({
          deliveryId: params.deliveryId,
          ownerToken,
          generation: 1,
          worktreePath,
          branch,
          baseCommit,
        });
      },
    );
    if (activation.contended !== true || attempt >= ACTIVATION_LOCK_ATTEMPTS) break;
    await delay(ACTIVATION_LOCK_DELAY_MS);
  }
  if (activation.status !== 'OK') {
    // The claim (and possibly the worktree) already exists — acquisition
    // cannot be retried by the caller; report retained-claim recovery.
    return {
      ...activation,
      deliveryId: params.deliveryId,
      recoveryRequired: true,
      message: `claim ${params.deliveryId} is retained for manual recovery — inspect, then resume after stopping with confirmation`,
    };
  }
  return activation;
}

async function markRecovery(repositoryPath, approval, record, reason) {
  try {
    await withRegistryLock({ repositoryPath, approval }, async (ctx) => {
      const current = ctx.records.find(
        (r) => r.deliveryId === record.deliveryId,
      );
      // Never overwrite a rotated, released, or otherwise changed claim with
      // a stale snapshot of ours.
      if (
        !current ||
        current.ownerToken !== record.ownerToken ||
        current.generation !== record.generation ||
        current.state !== 'PREPARING'
      ) {
        return blocked('OWNER_MISMATCH', 'claim changed during provisioning');
      }
      const write = await ctx.writeRecord({
        ...record,
        state: 'RECOVERY_REQUIRED',
        failure: { reason },
      });
      return write.status === 'OK' ? ok() : write;
    });
  } catch {
    // Lock unattainable or registry blocked: the PREPARING claim stays, which
    // still fails closed for later acquisitions.
  }
}

async function cmdHeartbeat(params) {
  const { repositoryPath, deliveryId, ownerToken, generation } = params;
  const registryState = await readRegistry({ repositoryPath });
  if (registryState.status !== 'OK') return registryState;
  const existing = registryState.records.find((r) => r.deliveryId === deliveryId);
  if (!existing) return blocked('OWNER_MISMATCH', `unknown delivery ${deliveryId}`);
  // The setup approval stored on the claim authorizes the mutex; no new user
  // approval is required for an owner heartbeat.
  const storedApproval = { confirmed: true, reference: existing.approval.reference };
  return withRegistryLock({ repositoryPath, approval: storedApproval }, async (ctx) => {
    const rec = ctx.records.find((r) => r.deliveryId === deliveryId);
    if (
      !rec ||
      rec.state !== 'ACTIVE' ||
      rec.ownerToken !== ownerToken ||
      rec.generation !== generation
    ) {
      return blocked('OWNER_MISMATCH', 'stale owner token, generation, or state');
    }
    if (rec.repositoryRoot !== await mainWorktreeRoot(repositoryPath)) {
      return blocked('RECOVERY_REQUIRED', 'claim is bound to a different main checkout');
    }
    const heartbeatAt = isoNow();
    const write = await ctx.writeRecord({ ...rec, heartbeatAt });
    if (write.status !== 'OK') return write;
    return ok({ deliveryId, heartbeatAt });
  });
}

async function cmdExtend(params) {
  const approvalErr = requireEvidence(params, 'approval');
  if (approvalErr) return approvalErr;
  const { repositoryPath, deliveryId, ownerToken, generation, approval } = params;
  const added = normalizeScopeOrError(params.scope);
  if (added.error) return added.error;

  return withRegistryLock({ repositoryPath, approval }, async (ctx) => {
    const rec = ctx.records.find((r) => r.deliveryId === deliveryId);
    if (
      !rec ||
      rec.state !== 'ACTIVE' ||
      rec.ownerToken !== ownerToken ||
      rec.generation !== generation
    ) {
      return blocked('OWNER_MISMATCH', 'stale owner token, generation, or state');
    }
    const mainRoot = await mainWorktreeRoot(repositoryPath);
    if (rec.repositoryRoot !== mainRoot) {
      return blocked('RECOVERY_REQUIRED', 'claim is bound to a different main checkout');
    }
    const merged = normalizeScope([...rec.scope, ...added]);
    const addedOnly = merged.filter(
      (e) => !rec.scope.some((old) => comparisonKey(old) === comparisonKey(e)),
    );
    const claims = checkClaimsFor(
      ctx.records,
      deliveryId,
      merged,
      mainRoot,
    );
    if (claims) return claims;
    // Newly claimed entries must not be symlink aliases inside the current
    // worktree — an alias could reach bytes another claim owns.
    const aliasHit = findWorktreeSymlink(rec.worktreePath, addedOnly);
    if (aliasHit === 'FS_ERROR' || aliasHit === 'SCAN_LIMIT') {
      return blocked('RECOVERY_REQUIRED', `cannot fully inspect extended scope: ${aliasHit}`);
    }
    if (aliasHit) {
      return blocked('SCOPE_CONFLICT', `extended scope contains a symlink alias: ${aliasHit}`);
    }
    // Extension only widens future write authorization; writes already made
    // outside the old scope are reported by the workflow, never laundered here.
    const write = await ctx.writeRecord({ ...rec, scope: merged, approval });
    if (write.status !== 'OK') return write;
    return ok({ deliveryId, scope: merged });
  });
}

async function cmdResume(params) {
  const approvalErr = requireEvidence(params, 'approval', 'stoppedConfirmation');
  if (approvalErr) return approvalErr;
  const { repositoryPath, deliveryId, expectedGeneration, approval, stoppedConfirmation } = params;

  let mainRoot;
  try {
    mainRoot = await mainWorktreeRoot(repositoryPath);
  } catch {
    return fail('INVALID_INPUT', 'cannot resolve main worktree');
  }

  return withRegistryLock({ repositoryPath, approval }, async (ctx) => {
    const rec = ctx.records.find((r) => r.deliveryId === deliveryId);
    if (!rec) return blocked('OWNER_MISMATCH', `unknown delivery ${deliveryId}`);
    if (rec.state === 'RELEASED' || rec.generation !== expectedGeneration) {
      return blocked('OWNER_MISMATCH', 'stale expected generation or released claim');
    }
    if (rec.generation >= Number.MAX_SAFE_INTEGER) {
      return fail('INVALID_INPUT', 'generation overflow');
    }
    if (rec.repositoryRoot !== mainRoot) {
      return blocked('RECOVERY_REQUIRED', 'claim is bound to a different main checkout');
    }
    // No overlapping live claim may be resumed into.
    const claims = checkClaimsFor(ctx.records, deliveryId, rec.scope, mainRoot);
    if (claims) return claims;
    // A partial or missing worktree cannot be resumed; it stays blocking until
    // a user-confirmed release.
    if (
      checkWorktreePathChain(rec.repositoryRoot, deliveryId) !== 'exists' ||
      realpathSync(rec.worktreePath) !== rec.worktreePath
    ) {
      return blocked('RECOVERY_REQUIRED', 'claimed worktree has missing or redirected ancestors');
    }
    let wtExists = false;
    try {
      wtExists = lstatSync(rec.worktreePath).isDirectory();
    } catch {
      wtExists = false;
    }
    if (!wtExists) {
      return blocked(
        'RECOVERY_REQUIRED',
        'claimed worktree is missing; release after stopping is the recovery path',
      );
    }
    const wtCommon = await gitTry(rec.worktreePath, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]);
    const wtBranch = await gitTry(rec.worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (
      !wtCommon ||
      realpathSync(wtCommon.trim()) !== ctx.commonDir ||
      (wtBranch || '').trim() !== rec.branch
    ) {
      return blocked('RECOVERY_REQUIRED', 'claimed worktree failed Git identity verification');
    }
    const generation = rec.generation + 1;
    const newToken = randomUUID();
    const write = await ctx.writeRecord({
      ...rec,
      state: 'ACTIVE',
      ownerToken: newToken,
      generation,
      approval,
      stoppedConfirmation,
      stoppedConfirmedAt: isoNow(),
      heartbeatAt: isoNow(),
    });
    if (write.status !== 'OK') return write;
    return ok({
      deliveryId,
      ownerToken: newToken,
      generation,
      worktreePath: rec.worktreePath,
      branch: rec.branch,
      baseCommit: rec.baseCommit,
    });
  });
}

async function cmdRelease(params) {
  const approvalErr = requireEvidence(params, 'approval', 'stoppedConfirmation');
  if (approvalErr) return approvalErr;
  const { repositoryPath, deliveryId, expectedGeneration, approval, stoppedConfirmation } = params;

  return withRegistryLock({ repositoryPath, approval }, async (ctx) => {
    const rec = ctx.records.find((r) => r.deliveryId === deliveryId);
    if (!rec) return blocked('OWNER_MISMATCH', `unknown delivery ${deliveryId}`);
    if (rec.state === 'RELEASED' || rec.generation !== expectedGeneration) {
      return blocked('OWNER_MISMATCH', 'stale expected generation or already released');
    }
    if (rec.generation >= Number.MAX_SAFE_INTEGER) {
      return fail('INVALID_INPUT', 'generation overflow');
    }
    const generation = rec.generation + 1;
    // Tombstone: rotate the token and bump the generation so every prior
    // credential and concurrent recovery attempt is fenced. The worktree,
    // branch, dirty and untracked files are never touched.
    const write = await ctx.writeRecord({
      ...rec,
      state: 'RELEASED',
      ownerToken: randomUUID(),
      generation,
      approval,
      stoppedConfirmation,
      stoppedConfirmedAt: isoNow(),
      releasedAt: isoNow(),
    });
    if (write.status !== 'OK') return write;
    return ok({ deliveryId, generation });
  });
}

const COMMANDS = {
  status: cmdStatus,
  acquire: cmdAcquire,
  extend: cmdExtend,
  heartbeat: cmdHeartbeat,
  resume: cmdResume,
  release: cmdRelease,
};

export async function runSessionCommand(command, request = {}) {
  let serialized;
  try {
    serialized = JSON.stringify(request ?? null);
  } catch {
    return fail('INVALID_INPUT', 'request is not serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > REQUEST_LIMIT) {
    return fail('INVALID_INPUT', `request exceeds ${REQUEST_LIMIT} bytes`);
  }
  const { params, error } = validateRequest(command, request);
  if (error) return error;
  try {
    return await COMMANDS[command](params);
  } catch (err) {
    return fail('RECOVERY_REQUIRED', String(err && err.message ? err.message : err));
  }
}

// ---------- CLI ----------

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

async function main() {
  const command = process.argv[2];
  let input = '';
  let oversized = false;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > REQUEST_LIMIT) {
      oversized = true;
      break;
    }
  }
  let result;
  if (oversized) {
    result = fail('INVALID_INPUT', `request exceeds ${REQUEST_LIMIT} bytes`);
  } else {
    let request = {};
    if (input.trim().length > 0) {
      try {
        request = JSON.parse(input);
      } catch {
        request = null;
      }
      if (request === null) {
        result = fail('INVALID_INPUT', 'stdin is not valid JSON');
      }
    }
    if (result === undefined) {
      if (!command || !Object.hasOwn(COMMANDS, command) || process.argv.length !== 3) {
        result = fail('INVALID_INPUT', `unknown command ${command ?? '(none)'}`);
      } else {
        result = await runSessionCommand(command, request);
      }
    }
  }
  if (result.status !== 'OK') {
    process.stderr.write(`delivery-session: ${result.status} ${result.code}: ${result.message ?? ''}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.status === 'OK' ? 0 : result.status === 'BLOCKED' ? 2 : 1);
}

if (isMain()) {
  main().catch((err) => {
    const result = fail('RECOVERY_REQUIRED', String(err && err.message ? err.message : err));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(1);
  });
}
