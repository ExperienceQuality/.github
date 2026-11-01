// Shared Git/worktree/exclude/symlink helpers for the concurrent-delivery
// modules. Internal plumbing only — every caller (session, verifier) keeps
// its own policy decisions.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { lstatSync, realpathSync, readdirSync } from 'node:fs';

const execFileP = promisify(execFile);

export const EXCLUDE_LINE = '/.squad/worktrees/';
export const SCAN_CAP = 10000;

export function blocked(code, message, extra = {}) {
  return { status: 'BLOCKED', code, ...(message ? { message } : {}), ...extra };
}

// ---------- git helpers (execFile, argument arrays, no shell) ----------

export const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

export async function gitOut(cwd, args, opts = {}) {
  const { stdout } = await execFileP('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: GIT_ENV,
    ...opts,
  });
  return stdout;
}

export async function gitTry(cwd, args) {
  try {
    return await gitOut(cwd, args);
  } catch {
    return null;
  }
}

export async function gitBlob(cwd, spec) {
  try {
    const { stdout } = await execFileP('git', ['-C', cwd, 'cat-file', '-p', spec], {
      encoding: 'buffer',
      env: GIT_ENV,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

export async function resolveRepository(repositoryPath) {
  const common = await gitOut(repositoryPath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  return { commonDir: realpathSync(common.trim()) };
}

export async function mainWorktreeRoot(repositoryPath) {
  const out = await gitOut(repositoryPath, ['worktree', 'list', '--porcelain', '-z']);
  const first = out.split('\0').find((t) => t.startsWith('worktree '));
  return first ? realpathSync(first.slice('worktree '.length)) : null;
}

export async function resolveCommit(cwd, ref) {
  const out = await gitTry(cwd, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ]);
  return out ? out.trim() : null;
}

export async function branchExists(cwd, branch) {
  return (
    (await gitTry(cwd, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}`])) !==
    null
  );
}

// Return a scope entry (or ancestor) that is/contains a symlink in the base
// tree — a lexical alias that could collide with a differently-named claim.
export async function findBaseSymlinkAlias(cwd, baseCommit, scope) {
  for (const entry of scope) {
    if (entry === '.') continue; // root scope: per-path verifier handles writes
    const segs = entry.replace(/\/$/, '').split('/');
    for (let i = 1; i <= segs.length; i += 1) {
      const p = segs.slice(0, i).join('/');
      const out = await gitTry(cwd, ['ls-tree', '-z', baseCommit, '--', p]);
      if (out && out.split('\0')[0].startsWith('120000 ')) return p;
    }
    if (entry.endsWith('/')) {
      const out = await gitTry(cwd, ['ls-tree', '-r', '-z', baseCommit, '--', entry]);
      if (out && out.split('\0').some((l) => l.startsWith('120000 '))) return entry;
    }
  }
  return null;
}

// Same check against the live worktree filesystem (used by extend). Only
// ENOENT means absent — other fs errors surface as 'FS_ERROR' so callers
// fail closed.
export function findWorktreeSymlink(worktreePath, entries) {
  const budget = { left: SCAN_CAP };
  for (const entry of entries) {
    if (entry === '.') continue;
    const segs = entry.replace(/\/$/, '').split('/');
    let cur = worktreePath;
    let deepest;
    for (const s of segs) {
      cur = path.join(cur, s);
      let st;
      try {
        st = lstatSync(cur);
      } catch (err) {
        if (err.code !== 'ENOENT') return 'FS_ERROR';
        deepest = null;
        break;
      }
      deepest = st;
      if (st.isSymbolicLink()) return entry;
      if (!st.isDirectory()) break;
    }
    if (entry.endsWith('/') && deepest && deepest.isDirectory()) {
      const hit = scanTreeForSymlink(cur, budget);
      if (hit) return hit;
      if (budget.left <= 0) return 'SCAN_LIMIT';
    }
  }
  return null;
}

function scanTreeForSymlink(dir, budget) {
  const stack = [dir];
  while (stack.length) {
    if (budget.left <= 0) return 'SCAN_LIMIT';
    const d = stack.pop();
    let names;
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      return 'FS_ERROR';
    }
    for (const ent of names) {
      budget.left -= 1;
      const p = path.join(d, ent.name);
      if (ent.isSymbolicLink()) return p;
      if (ent.isDirectory()) stack.push(p);
    }
  }
  return null;
}

// Walk the main-checkout path chain for the worktree root. Returns
// 'exists' (target present), 'invalid' (symlink/file ancestor), or null.
export function checkWorktreePathChain(mainRoot, deliveryId) {
  const segs = ['.squad', 'worktrees', deliveryId];
  let cur = mainRoot;
  for (let i = 0; i < segs.length; i += 1) {
    cur = path.join(cur, segs[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if (err.code === 'ENOENT') return null; // deeper segments cannot exist
      return 'invalid';
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return 'invalid';
    if (i === segs.length - 1) return 'exists';
  }
  return null;
}

// Shape-only preflight (safe to run before any mutation): returns a blocked
// result when info/ or info/exclude is a symlink or wrong kind, else null.
export function checkExcludeShape(commonDir) {
  const infoDir = path.join(commonDir, 'info');
  const excludePath = path.join(infoDir, 'exclude');
  for (const [p, dir] of [
    [infoDir, true],
    [excludePath, false],
  ]) {
    let st;
    try {
      st = lstatSync(p);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      return blocked('RECOVERY_REQUIRED', `cannot inspect ${p}`);
    }
    if (st.isSymbolicLink() || (dir ? !st.isDirectory() : !st.isFile())) {
      return blocked('RECOVERY_REQUIRED', `${p} is not a plain ${dir ? 'directory' : 'file'}`);
    }
  }
  return null;
}

// Append the anchored worktree line without rewriting existing bytes. Runs
// under the registry mutex; rechecks shape because state may have changed
// since preflight.
export async function ensureExcludeLine(commonDir) {
  const shape = checkExcludeShape(commonDir);
  if (shape) return shape;
  const infoDir = path.join(commonDir, 'info');
  const excludePath = path.join(infoDir, 'exclude');
  let content = '';
  try {
    content = await fs.readFile(excludePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      return blocked('RECOVERY_REQUIRED', `cannot read exclude: ${err.message}`);
    }
  }
  // Match lines regardless of LF/CRLF endings without rewriting them.
  if (content.split('\n').some((l) => l.replace(/\r$/, '') === EXCLUDE_LINE)) return null;
  try {
    await fs.mkdir(infoDir, { recursive: true });
    const separator = content && !content.endsWith('\n') ? '\n' : '';
    await fs.appendFile(excludePath, separator + EXCLUDE_LINE + '\n');
  } catch (err) {
    return blocked('RECOVERY_REQUIRED', `cannot append exclude: ${err.message}`);
  }
  return null;
}
