// Delivery write-scope contract: literal repo-relative POSIX paths only.
// Entries are an exact file, a subtree (trailing '/'), or '.' for the whole
// repository. No globs. Comparison is deliberately conservative: NFC plus
// uppercase-then-lowercase folding (not full Unicode casefold), so
// canonically similar names collide rather than rely on filesystem-exact
// matching.

import path from 'node:path';
import fs from 'node:fs/promises';

const FORBIDDEN_CHARS = /[\x00-\x1f\x7f\\*?[\]{}]/;
const INTERNAL_TREES = [
  ['.squad', 'run'],
  ['.squad', 'worktrees'],
];

export function comparisonKey(value) {
  return value.normalize('NFC').toUpperCase().toLowerCase();
}

function invalid(entry, why) {
  throw new Error(`invalid scope entry ${JSON.stringify(entry)}: ${why}`);
}

function foldedSegs(segs) {
  return segs.map(comparisonKey);
}

function isInternalSegs(fSegs) {
  if (fSegs.includes('.git')) return true;
  return INTERNAL_TREES.some(
    (tree) => fSegs.length >= tree.length && tree.every((s, i) => fSegs[i] === s),
  );
}

// Parses a scope entry into { orig, segs, keySegs, isTree, isRoot }.
// Throws on any non-canonical input.
export function parseScopeEntry(entry) {
  if (typeof entry !== 'string' || entry.length === 0) {
    invalid(entry, 'must be a non-empty string');
  }
  if (entry === '.') {
    return { orig: entry, segs: [], keySegs: [], isTree: false, isRoot: true };
  }
  if (entry.startsWith('/')) invalid(entry, 'absolute paths are not allowed');
  if (FORBIDDEN_CHARS.test(entry)) {
    invalid(entry, 'contains control, backslash, or glob characters');
  }
  const isTree = entry.endsWith('/');
  const body = isTree ? entry.slice(0, -1) : entry;
  const segs = body.split('/');
  for (const seg of segs) {
    if (seg === '') invalid(entry, 'empty or doubled path segments');
    if (seg === '.' || seg === '..') invalid(entry, 'non-canonical or traversal segments');
  }
  const keySegs = foldedSegs(segs);
  if (isInternalSegs(keySegs)) invalid(entry, 'internal .git/.squad runtime path');
  return { orig: entry, segs, keySegs, isTree, isRoot: false };
}

// Validates every entry and returns sorted, deduplicated original strings.
// Dedup uses the conservative comparison key; the first sorted spelling wins.
export function normalizeScope(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('invalid scope entry list: expected an array');
  }
  const parsed = entries.map(parseScopeEntry);
  parsed.sort((a, b) => {
    const ka = a.keySegs.join('/') + (a.isTree ? '/' : '');
    const kb = b.keySegs.join('/') + (b.isTree ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : a.orig < b.orig ? -1 : 1;
  });
  const out = [];
  let lastKey = null;
  for (const p of parsed) {
    const key = p.keySegs.join('/') + (p.isTree ? '/' : '');
    if (key === lastKey) continue;
    lastKey = key;
    out.push(p.orig);
  }
  return out;
}

function isPrefixSegs(prefix, full) {
  return prefix.length <= full.length && prefix.every((s, i) => full[i] === s);
}

// Returns sorted {left, right} pairs of conflicting entries. Two entries
// conflict when either is root scope or one's folded segments are an
// ancestor-or-equal prefix of the other's — covering file==file,
// file-inside-tree, tree ancestor/descendant, and same-prefix file/tree.
export function findScopeConflicts(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    throw new Error('invalid scope entry list: expected arrays');
  }
  const ls = left.map(parseScopeEntry);
  const rs = right.map(parseScopeEntry);
  const seen = new Set();
  const pairs = [];
  for (const l of ls) {
    for (const r of rs) {
      const conflict =
        l.isRoot ||
        r.isRoot ||
        isPrefixSegs(l.keySegs, r.keySegs) ||
        isPrefixSegs(r.keySegs, l.keySegs);
      if (!conflict) continue;
      const dedupeKey = JSON.stringify([l.orig, r.orig]);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      pairs.push({ left: l.orig, right: r.orig });
    }
  }
  pairs.sort((a, b) =>
    a.left < b.left ? -1 : a.left > b.left ? 1 : a.right < b.right ? -1 : a.right > b.right ? 1 : 0,
  );
  return pairs;
}

// Resolves the real absolute location of a lexical target: realpath of the
// nearest existing ancestor plus the missing tail. Returns { realAbs } or
// { reason } when resolution is impossible (broken symlink, no ancestor).
async function resolveInside(root, lexSegs) {
  const missing = [];
  let existing = path.join(root, ...lexSegs);
  for (;;) {
    try {
      await fs.lstat(existing);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(existing);
      if (parent === existing) return { reason: 'no existing ancestor' };
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  let realAncestor;
  try {
    realAncestor = await fs.realpath(existing);
  } catch {
    return { reason: 'unresolvable or broken symlink ancestor' };
  }
  return { realAbs: path.join(realAncestor, ...missing) };
}

function coveredByScope(entries, keySegs) {
  return entries.some(
    (e) =>
      e.isRoot ||
      (e.isTree ? isPrefixSegs(e.keySegs, keySegs) : keySegs.join('/') === e.keySegs.join('/')),
  );
}

async function checkWritePath(root, entries, raw) {
  if (typeof raw !== 'string' || raw.length === 0) return 'not a non-empty string';
  if (FORBIDDEN_CHARS.test(raw)) return 'control, backslash, or glob characters';
  let lexSegs;
  if (path.isAbsolute(raw)) {
    const rel = path.relative(root, raw);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      return 'escapes worktree';
    }
    lexSegs = rel.split(path.sep);
  } else {
    if (raw.startsWith('/')) return 'absolute paths outside worktree';
    lexSegs = raw.split('/');
  }
  for (const seg of lexSegs) {
    if (seg === '' || seg === '.' || seg === '..') {
      return 'empty, current, or traversal segments';
    }
  }
  const lexKey = foldedSegs(lexSegs);
  if (isInternalSegs(lexKey)) return 'internal .git/.squad runtime path';

  const resolved = await resolveInside(root, lexSegs);
  if (resolved.reason) return resolved.reason;
  if (!resolved.realAbs.startsWith(root + path.sep)) {
    return 'symlink escape outside worktree';
  }
  const realRel = path.relative(root, resolved.realAbs);
  const lexRel = lexSegs.join('/');
  // A canonical target that differs from the written name only by case or
  // normalization is an ambiguous alias — refuse rather than guess intent.
  if (realRel !== lexRel && comparisonKey(realRel) === comparisonKey(lexRel)) {
    return 'ambiguous case/NFC path alias';
  }
  const realKey = foldedSegs(realRel.split(path.sep));
  if (isInternalSegs(realKey)) return 'alias resolves into internal runtime path';
  // Both the written path and its resolved target must be inside scope;
  // a covered real target never broadens access to an uncovered alias.
  if (!coveredByScope(entries, lexKey)) return 'lexical path outside declared scope';
  if (!coveredByScope(entries, realKey)) return 'resolved target outside declared scope';
  return null;
}

// Async scope verification for actual write paths. Lexical paths are
// validated, symlink ancestors are resolved through the canonical worktree
// root, and the resolved target must stay inside the worktree and inside the
// declared scope. Aliases are honoured only when the real target is covered.
export async function validateWritePaths({ worktreePath, paths, scope } = {}) {
  try {
    if (typeof worktreePath !== 'string' || !path.isAbsolute(worktreePath)) {
      return { status: 'ERROR', code: 'INVALID_INPUT', message: 'worktreePath must be absolute' };
    }
    if (!Array.isArray(paths) || !Array.isArray(scope)) {
      return { status: 'ERROR', code: 'INVALID_INPUT', message: 'paths and scope must be arrays' };
    }
    const root = await fs.realpath(worktreePath);
    const entries = scope.map(parseScopeEntry);
    const violations = [];
    for (const raw of paths) {
      const reason = await checkWritePath(root, entries, raw);
      if (reason !== null) violations.push({ path: raw, reason });
    }
    if (violations.length > 0) {
      return { status: 'BLOCKED', code: 'SCOPE_CONFLICT', violations };
    }
    return { status: 'OK', code: 'OK' };
  } catch (err) {
    return { status: 'ERROR', code: 'INVALID_INPUT', message: String(err.message || err) };
  }
}
