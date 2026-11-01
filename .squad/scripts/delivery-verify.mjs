// Concurrent-delivery write verification — T6.
// captureDeliverySnapshot(context) binds an owned ACTIVE claim to a snapshot
// of the worktree's authored state; verifyDeliveryWrites(context, baseline)
// fails closed on ownership, worktree-identity, baseline-staleness, or any
// out-of-scope authored path. Neither function mutates: no mutex is taken,
// no Git write commands run.
//
// Authored paths = working+staged changes vs HEAD, committed delivery patch
// vs merge-base(HEAD, resolved baseRef), non-ignored untracked files, and
// (on verify) ignored files whose detectable fingerprint changed. All are
// validated through the real validateWritePaths.

import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream, realpathSync } from 'node:fs';
import { validateWritePaths } from './delivery-scope.mjs';
import { readOwnedClaim, REGISTRY_LIMITS } from './delivery-registry.mjs';
import { gitOut, gitTry, resolveCommit, blocked } from './delivery-worktree.mjs';

const SNAPSHOT_VERSION = 1;
const LS_FILES_CAP = 100000;
const GIT_OUT_CAP = 16 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function ok(extra = {}) {
  return { status: 'OK', code: 'OK', ...extra };
}

function fail(code, message, extra = {}) {
  return { status: 'ERROR', code, ...(message ? { message } : {}), ...extra };
}

// ---------- context / baseline validation ----------

function checkContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return fail('INVALID_INPUT', 'context must be an object');
  }
  for (const k of Object.keys(context)) {
    if (!['repositoryPath', 'deliveryId', 'ownerToken', 'generation', 'worktreePath'].includes(k)) {
      return fail('INVALID_INPUT', `unknown context field ${k}`);
    }
  }
  const { repositoryPath, deliveryId, ownerToken, generation, worktreePath } = context;
  if (typeof repositoryPath !== 'string' || !path.isAbsolute(repositoryPath)) {
    return fail('INVALID_INPUT', 'repositoryPath must be an absolute path');
  }
  if (
    typeof deliveryId !== 'string' ||
    deliveryId.length > REGISTRY_LIMITS.maxIdChars ||
    !ID_PATTERN.test(deliveryId)
  ) {
    return fail('INVALID_INPUT', 'invalid deliveryId');
  }
  if (typeof ownerToken !== 'string' || ownerToken.length === 0) {
    return fail('INVALID_INPUT', 'invalid ownerToken');
  }
  if (!Number.isSafeInteger(generation) || generation < 1) {
    return fail('INVALID_INPUT', 'invalid generation');
  }
  if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath)) {
    return fail('INVALID_INPUT', 'worktreePath must be an absolute path');
  }
  return null;
}

function isFingerprint(fp) {
  if (!fp || typeof fp !== 'object' || Array.isArray(fp)) return false;
  const keys = Object.keys(fp);
  if (fp.t === 'f') {
    return keys.length === 2 && keys.includes('h') && SHA256_PATTERN.test(fp.h || '');
  }
  if (fp.t === 'i') {
    return (
      keys.length === 3 &&
      keys.includes('s') &&
      keys.includes('m') &&
      Number.isFinite(fp.s) &&
      fp.s >= 0 &&
      Number.isFinite(fp.m) &&
      fp.m >= 0
    );
  }
  if (fp.t === 'l') return keys.length === 2 && keys.includes('l') && typeof fp.l === 'string';
  if (fp.t === 'd' || fp.t === 'missing') return keys.length === 1;
  return false;
}

// Baseline file keys are untrusted data: canonical relative repo paths only.
function isCanonicalRelPath(p) {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length <= 4096 &&
    !path.isAbsolute(p) &&
    !p.includes('\\') &&
    !/[\x00-\x1f\x7f]/.test(p) &&
    path.posix.normalize(p) === p &&
    !p.split('/').some((s) => s === '' || s === '.' || s === '..')
  );
}

function checkBaseline(baseline, context) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return fail('INVALID_INPUT', 'baseline must be an object');
  }
  for (const k of Object.keys(baseline)) {
    if (
      ![
        'version',
        'deliveryId',
        'generation',
        'worktreePath',
        'baseCommit',
        'head',
        'resolvedTarget',
        'files',
      ].includes(k)
    ) {
      return fail('INVALID_INPUT', `unknown baseline field ${k}`);
    }
  }
  const b = baseline;
  if (
    b.version !== SNAPSHOT_VERSION ||
    b.deliveryId !== context.deliveryId ||
    b.generation !== context.generation ||
    typeof b.worktreePath !== 'string' ||
    !SHA_PATTERN.test(b.baseCommit || '') ||
    !SHA_PATTERN.test(b.head || '') ||
    !SHA_PATTERN.test(b.resolvedTarget || '') ||
    !b.files ||
    typeof b.files !== 'object' ||
    Array.isArray(b.files) ||
    Object.keys(b.files).length > LS_FILES_CAP ||
    Object.keys(b.files).some((k) => !isCanonicalRelPath(k)) ||
    Object.values(b.files).some((fp) => !isFingerprint(fp))
  ) {
    return fail('INVALID_INPUT', 'baseline failed shape/binding validation');
  }
  return null;
}

// ---------- worktree identity ----------

async function verifyWorktreeIdentity(context, claim, commonDir) {
  let real;
  try {
    real = realpathSync(context.worktreePath);
  } catch {
    return blocked('RECOVERY_REQUIRED', 'claimed worktree path cannot be resolved');
  }
  if (real !== claim.worktreePath) {
    return blocked('RECOVERY_REQUIRED', 'worktree path does not match the claim binding');
  }
  if (real === claim.repositoryRoot) {
    return blocked('RECOVERY_REQUIRED', 'claimed worktree resolves to the main checkout');
  }
  const wtCommon = await gitTry(real, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!wtCommon || realpathSync(wtCommon.trim()) !== commonDir) {
    return blocked('RECOVERY_REQUIRED', 'worktree Git common dir does not match the claim registry');
  }
  const branch = await gitTry(real, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if ((branch || '').trim() !== claim.branch) {
    return blocked('RECOVERY_REQUIRED', 'worktree is not on the claimed delivery branch');
  }
  const baseOk = await gitTry(real, ['cat-file', '-e', `${claim.baseCommit}^{commit}`]);
  if (baseOk === null) {
    return blocked('RECOVERY_REQUIRED', 'recorded base commit is not resolvable in the worktree');
  }
  return { real };
}

// ---------- enumeration + fingerprints ----------

async function lsFiles(worktreePath, args) {
  const out = await gitOut(worktreePath, ['ls-files', '-z', ...args], {
    maxBuffer: GIT_OUT_CAP * 2,
  });
  const bytes = Buffer.byteLength(out, 'utf8');
  if (bytes > GIT_OUT_CAP) {
    throw blocked('RECOVERY_REQUIRED', 'ls-files output exceeds the capture cap');
  }
  return out.split('\0').filter(Boolean);
}

async function fingerprintPath(root, rel, ignored) {
  const abs = path.join(root, rel);
  let st;
  try {
    st = await fs.lstat(abs);
  } catch (err) {
    // Absent at fingerprint time (e.g. a tracked path deleted in-scope) is a
    // real state, not an error; any other failure is fail-closed.
    if (err && err.code === 'ENOENT') return { t: 'missing' };
    throw err;
  }
  if (st.isSymbolicLink()) {
    return { t: 'l', l: await fs.readlink(abs) };
  }
  if (!st.isFile()) {
    // Non-file node (directory, uninitialized submodule gitlink, etc.): record
    // presence only — contents are never traversed.
    return { t: 'd' };
  }
  if (ignored) {
    // Ignored files: detectable metadata only — size/mtime (+ readlink above
    // for symlinks). No guarantee against metadata-preserving overwrites.
    return { t: 'i', s: st.size, m: st.mtimeMs };
  }
  const hash = createHash('sha256');
  const stream = createReadStream(abs);
  try {
    for await (const chunk of stream) hash.update(chunk);
  } catch (err) {
    stream.destroy();
    throw err; // read race/IO failure — the caller fails closed
  }
  return { t: 'f', h: hash.digest('hex') };
}

// `git ls-files -v -z` entries are "<tag> <path>" NUL-separated. Uppercase
// 'S' marks skip-worktree and a lowercase tag letter marks assume-unchanged;
// both hide the file from `git diff`, so suppressed paths are authored state
// the verifier must check rather than trust.
function parseSuppressed(entries) {
  const paths = [];
  for (const entry of entries) {
    if (!/^[A-Za-z?] /.test(entry)) {
      throw blocked('RECOVERY_REQUIRED', 'unrecognized index visibility entry');
    }
    const tag = entry[0];
    if (tag === 'S' || (tag >= 'a' && tag <= 'z')) paths.push(entry.slice(2));
  }
  return paths;
}

// Parse `git diff --name-status -z -M` output into repo-relative authored
// paths (rename entries contribute source AND destination).
function parseNameStatus(out) {
  const tokens = out.split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i];
    if (status.startsWith('R') || status.startsWith('C')) {
      paths.push(tokens[i + 1], tokens[i + 2]);
      i += 2;
    } else {
      paths.push(tokens[i + 1]);
      i += 1;
    }
  }
  return paths.filter(Boolean);
}

async function collectState(worktreePath, claim) {
  const head = await resolveCommit(worktreePath, 'HEAD');
  if (!head) throw blocked('RECOVERY_REQUIRED', 'worktree HEAD is not resolvable');
  const resolvedTarget = await resolveCommit(worktreePath, claim.baseRef);
  if (!resolvedTarget) {
    throw blocked('RECOVERY_REQUIRED', `baseRef ${claim.baseRef} is not resolvable`);
  }
  const mergeBaseOut = await gitTry(worktreePath, ['merge-base', 'HEAD', resolvedTarget]);
  const mergeBase = mergeBaseOut ? mergeBaseOut.split('\n')[0].trim() : null;
  if (!mergeBase || !SHA_PATTERN.test(mergeBase)) {
    throw blocked('RECOVERY_REQUIRED', 'no merge base between HEAD and resolved baseRef');
  }

  const [cached, others, ignoredList, suppressedList, stagedOut, unstagedOut, patchOut] =
    await Promise.all([
      lsFiles(worktreePath, ['--cached']),
      lsFiles(worktreePath, ['--others']),
      lsFiles(worktreePath, ['--others', '--ignored', '--exclude-standard']),
      lsFiles(worktreePath, ['-v']),
      // Index-vs-HEAD and worktree-vs-index are collected separately: a staged
      // change canceled by later worktree bytes still marks the path authored.
      gitOut(worktreePath, ['diff', '--cached', '--name-status', '-z', '-M', 'HEAD']),
      gitOut(worktreePath, ['diff', '--name-status', '-z', '-M']),
      gitOut(worktreePath, ['diff', '--name-status', '-z', '-M', mergeBase, 'HEAD']),
    ]);
  if (cached.length + others.length > LS_FILES_CAP) {
    throw blocked('RECOVERY_REQUIRED', 'file enumeration exceeds the entry cap');
  }
  const ignored = new Set(ignoredList);
  const authored = new Set([
    ...parseNameStatus(stagedOut),
    ...parseNameStatus(unstagedOut),
    ...parseNameStatus(patchOut),
    ...parseSuppressed(suppressedList),
    ...others.filter((p) => !ignored.has(p)),
  ]);
  const files = new Set([...cached, ...others]);
  return { head, resolvedTarget, mergeBase, ignored, authored, files };
}

async function fingerprintAll(root, files, ignored) {
  const map = Object.create(null);
  for (const rel of files) {
    map[rel] = await fingerprintPath(root, rel, ignored.has(rel));
  }
  return map;
}

async function checkAuthoredScope(worktreePath, record, authored) {
  if (authored.size === 0) return null;
  const res = await validateWritePaths({
    worktreePath,
    paths: [...authored],
    scope: record.scope,
  });
  if (res.status !== 'OK') return res;
  return null;
}

// ---------- exports ----------

export async function captureDeliverySnapshot(context = {}) {
  const ctxErr = checkContext(context);
  if (ctxErr) return ctxErr;
  try {
    const owned = await readOwnedClaim(context);
    if (owned.status !== 'OK') return owned;
    const claim = owned.record;
    const identity = await verifyWorktreeIdentity(context, claim, owned.commonDir);
    if (identity.real === undefined) return identity;

    const state = await collectState(identity.real, claim);
    // Capture never launders violations: any existing out-of-scope authored
    // change blocks the snapshot outright.
    const scopeBlock = await checkAuthoredScope(identity.real, claim, state.authored);
    if (scopeBlock) return scopeBlock;
    const files = await fingerprintAll(identity.real, state.files, state.ignored);

    // Ownership must still hold after the collection pass.
    const owned2 = await readOwnedClaim(context);
    if (owned2.status !== 'OK') return owned2;

    return ok({
      snapshot: {
        version: SNAPSHOT_VERSION,
        deliveryId: context.deliveryId,
        generation: context.generation,
        worktreePath: identity.real,
        baseCommit: claim.baseCommit,
        head: state.head,
        resolvedTarget: state.resolvedTarget,
        files,
      },
    });
  } catch (err) {
    if (err && err.status === 'BLOCKED') return err;
    return fail('RECOVERY_REQUIRED', String(err && err.message ? err.message : err));
  }
}

export async function verifyDeliveryWrites(context = {}, baseline = {}) {
  const ctxErr = checkContext(context);
  if (ctxErr) return ctxErr;
  const baseErr = checkBaseline(baseline, context);
  if (baseErr) return baseErr;
  try {
    const owned = await readOwnedClaim(context);
    if (owned.status !== 'OK') return owned;
    const claim = owned.record;
    const identity = await verifyWorktreeIdentity(context, claim, owned.commonDir);
    if (identity.real === undefined) return identity;

    // Baseline must be bound to this exact claim state.
    if (
      baseline.worktreePath !== identity.real ||
      baseline.baseCommit !== claim.baseCommit ||
      baseline.deliveryId !== claim.deliveryId ||
      baseline.generation !== claim.generation
    ) {
      return blocked('RECOVERY_REQUIRED', 'baseline is not bound to this claim');
    }

    const state = await collectState(identity.real, claim);
    if (state.head !== baseline.head || state.resolvedTarget !== baseline.resolvedTarget) {
      return blocked(
        'RECOVERY_REQUIRED',
        'HEAD or resolved baseRef changed since capture — recapture requires authorized integration review',
      );
    }

    const authored = new Set(state.authored);
    // Ignored files absent from the baseline are new authored state.
    for (const rel of state.ignored) {
      if (!Object.hasOwn(baseline.files, rel)) authored.add(rel);
    }
    // Every baseline fingerprint is re-compared against current bytes —
    // tracked hashes catch writes hidden from `git diff` by suppression flags
    // or stat-fooling; ignored files compare detectable metadata only.
    for (const rel of Object.keys(baseline.files)) {
      const before = baseline.files[rel];
      const now = await fingerprintPath(identity.real, rel, before.t === 'i');
      if (JSON.stringify(before) !== JSON.stringify(now)) authored.add(rel);
    }

    const violations = [];
    if (authored.size > 0) {
      const res = await validateWritePaths({
        worktreePath: identity.real,
        paths: [...authored],
        scope: claim.scope,
      });
      if (res.status === 'BLOCKED') violations.push(...res.violations);
      else if (res.status !== 'OK') return res;
    }
    if (violations.length > 0) {
      return blocked('SCOPE_CONFLICT', 'out-of-scope authored writes detected', { violations });
    }

    const owned2 = await readOwnedClaim(context);
    if (owned2.status !== 'OK') return owned2;
    return ok();
  } catch (err) {
    if (err && err.status === 'BLOCKED') return err;
    return fail('RECOVERY_REQUIRED', String(err && err.message ? err.message : err));
  }
}
