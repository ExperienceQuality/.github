import { readFile, writeFile, rename, mkdir, copyFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, relative, sep } from 'node:path';

async function hashFile(path) {
  const hash = createHash('sha256');
  const { createReadStream } = await import('node:fs');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function readTextOrNull(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir) {
  const files = [];
  const stack = [dir];
  const { readdir } = await import('node:fs/promises');
  while (stack.length) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else files.push(path);
    }
  }
  return files.sort();
}

function atomicWrite(filePath, content) {
  const tmp = join(dirname(filePath), `.${filePath.split('/').pop()}.tmp`);
  return writeFile(tmp, content, 'utf8').then(() => rename(tmp, filePath));
}

// Merge-managed files have dedicated merge logic and are skipped by the
// generic hash-based upgrade.
const MERGE_MANAGED = new Set(['AGENTS.md', '.cursor/hooks.json']);
const UPSTREAM_SUFFIX = '.squad-upstream';

export async function upgradeManaged(targetDir, newDir, version) {
  const statePath = join(targetDir, '.squad', 'install-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const conflicts = [];
  const applied = [];

  const newFiles = await listFiles(newDir);
  const managedFiles = Object.keys(state.managed_files).filter(p => !MERGE_MANAGED.has(p));
  const appliedSet = new Set();
  const managedSet = new Set(managedFiles);

  for (const rel of managedFiles) {
    const consumerPath = join(targetDir, rel);
    const newPath = join(newDir, rel);
    const oldHash = state.managed_files[rel];

    const current = await readTextOrNull(consumerPath);
    const upstream = await readTextOrNull(newPath);

    if (!upstream) {
      // File removed in new release. Leave consumer-owned modifications; report if changed.
      if (current && await hashFile(consumerPath) !== oldHash) {
        conflicts.push({ file: rel, reason: 'upstream removed but consumer modified' });
      }
      continue;
    }

    if (!current) {
      // Missing locally; install fresh.
      await mkdir(dirname(consumerPath), { recursive: true });
      await copyFile(newPath, consumerPath);
      applied.push(rel);
      appliedSet.add(rel);
      continue;
    }

    if (await hashFile(consumerPath) === oldHash) {
      // Consumer has not modified; safe to replace.
      await mkdir(dirname(consumerPath), { recursive: true });
      await copyFile(newPath, consumerPath);
      applied.push(rel);
      appliedSet.add(rel);
      continue;
    }

    if (await hashFile(newPath) === oldHash) {
      // Upstream unchanged; keep consumer modifications.
      continue;
    }

    // Both changed. Keep the consumer file untouched, write the upstream
    // version next to it, and report the conflict. The recorded baseline hash
    // is kept, so the next upgrade still sees the consumer edit.
    await copyFile(newPath, consumerPath + UPSTREAM_SUFFIX);
    conflicts.push({ file: rel, reason: `modified locally and upstream; upstream version written to ${rel}${UPSTREAM_SUFFIX}` });
  }

  // Files first shipped in this release are absent from the recorded
  // manifest; adopt them unless an unrelated consumer file already occupies
  // the path, which is reported rather than overwritten.
  const adopted = [];
  for (const abs of newFiles) {
    const rel = relative(newDir, abs).split(sep).join('/');
    if (MERGE_MANAGED.has(rel) || managedSet.has(rel)) continue;
    const consumerPath = join(targetDir, rel);
    if (!(await exists(consumerPath))) {
      await mkdir(dirname(consumerPath), { recursive: true });
      await copyFile(abs, consumerPath);
      applied.push(rel);
      adopted.push(rel);
      continue;
    }
    if ((await hashFile(consumerPath)) === (await hashFile(abs))) {
      adopted.push(rel); // identical bytes already present; register as managed
    } else {
      await copyFile(abs, consumerPath + UPSTREAM_SUFFIX);
      conflicts.push({ file: rel, reason: `consumer file exists at new managed path; upstream version written to ${rel}${UPSTREAM_SUFFIX}` });
    }
  }

  // Merge AGENTS.md managed section separately
  const agentsResult = await mergeAgents(targetDir, newDir, state, version);
  if (agentsResult.conflicts.length) conflicts.push(...agentsResult.conflicts);
  if (agentsResult.applied) applied.push('AGENTS.md');

  const hooksResult = await mergeHooks(targetDir, newDir);
  conflicts.push(...hooksResult.conflicts);
  if (hooksResult.applied) applied.push('.cursor/hooks.json');

  // Update state
  const updatedManaged = {};
  for (const rel of Object.keys(state.managed_files)) {
    const consumerPath = join(targetDir, rel);
    if (!(await exists(consumerPath))) continue;
    // Only files actually written by this upgrade (and merge-managed files)
    // get a new baseline; kept consumer edits retain the old one.
    updatedManaged[rel] = appliedSet.has(rel) || MERGE_MANAGED.has(rel)
      ? await hashFile(consumerPath)
      : state.managed_files[rel];
  }
  if (hooksResult.applied) {
    updatedManaged['.cursor/hooks.json'] = await hashFile(join(targetDir, '.cursor', 'hooks.json'));
  }
  for (const rel of adopted) {
    updatedManaged[rel] = await hashFile(join(targetDir, rel));
  }

  const versionNumber = version.startsWith('v') ? version.slice(1) : version;
  const newState = {
    ...state,
    version: versionNumber,
    release_tag: version,
    managed_files: updatedManaged,
    updated_at: new Date().toISOString()
  };
  await atomicWrite(statePath, JSON.stringify(newState, null, 2) + '\n');

  return { applied, conflicts };
}

async function mergeAgents(targetDir, newDir, state, version) {
  const existingPath = join(targetDir, 'AGENTS.md');
  const newPath = join(newDir, 'AGENTS.md');
  const { mergeAgents: mergeAgentsMd } = await import('./merge-agents.mjs');
  await mergeAgentsMd(existingPath, newPath, existingPath);
  return { applied: true, conflicts: [] };
}

async function mergeHooks(targetDir, newDir) {
  const newPath = join(newDir, '.cursor', 'hooks.json');
  if (!(await exists(newPath))) return { applied: false, conflicts: [] };
  const existingPath = join(targetDir, '.cursor', 'hooks.json');
  await mkdir(dirname(existingPath), { recursive: true });
  const { mergeCursorHooks } = await import('./merge-cursor-hooks.mjs');
  const res = await mergeCursorHooks(existingPath, newPath, existingPath);
  if (res.status === 'conflict') {
    return { applied: false, conflicts: [{ file: '.cursor/hooks.json', reason: `${res.reason}; upstream version written to .cursor/hooks.json${UPSTREAM_SUFFIX}` }] };
  }
  return { applied: true, conflicts: [] };
}

async function main() {
  const [targetDir, newDir, version] = process.argv.slice(2);
  const result = await upgradeManaged(targetDir, newDir, version);

  if (result.conflicts.length) {
    console.error('Conflicts detected:');
    for (const c of result.conflicts) console.error(`  ${c.file}${c.line ? ':' + c.line : ''} ${c.reason || ''}`);
  }

  if (result.applied.length) {
    console.log('Updated files:');
    for (const f of result.applied) console.log(`  ${f}`);
  }

  process.exit(result.conflicts.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
