// Merge-managed .cursor/hooks.json. XQ Squad entries are identified by their
// command referencing .cursor/hooks/xq-squad-*. They are replaced with the
// distributed set. Consumer entries and other top-level keys are preserved.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';

export const SQUAD_HOOK_MARKER = '.cursor/hooks/xq-squad-';

const isSquadEntry = (entry) =>
  entry && typeof entry === 'object' && typeof entry.command === 'string' && entry.command.includes(SQUAD_HOOK_MARKER);

export function mergeHooksConfig(existing, distributed) {
  const result = { ...existing, version: existing.version ?? distributed.version };
  const hooks = {};
  for (const [event, entries] of Object.entries(existing.hooks || {})) {
    const kept = Array.isArray(entries) ? entries.filter((e) => !isSquadEntry(e)) : entries;
    if (!Array.isArray(kept) || kept.length) hooks[event] = kept;
  }
  for (const [event, entries] of Object.entries(distributed.hooks || {})) {
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), ...entries];
  }
  result.hooks = hooks;
  return result;
}

// Returns { status: 'merged' | 'created' | 'conflict', reason? }. An unparsable
// consumer file is never rewritten; the distributed copy is written next to it.
export async function mergeCursorHooks(existingPath, distributedPath, outputPath) {
  const distributed = JSON.parse(await readFile(distributedPath, 'utf8'));
  let text = null;
  try {
    text = await readFile(existingPath, 'utf8');
  } catch {}
  let merged;
  let status = 'created';
  if (text !== null) {
    let existing;
    try {
      existing = JSON.parse(text);
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('not an object');
      if (existing.hooks !== undefined && (typeof existing.hooks !== 'object' || Array.isArray(existing.hooks))) {
        throw new Error('hooks is not an object');
      }
    } catch (err) {
      await writeFile(`${existingPath}.squad-upstream`, JSON.stringify(distributed, null, 2) + '\n', 'utf8');
      return { status: 'conflict', reason: `consumer hooks.json is not valid hooks config (${err.message})` };
    }
    merged = mergeHooksConfig(existing, distributed);
    status = 'merged';
  } else {
    merged = distributed;
  }
  const tmp = join(dirname(outputPath), `.${basename(outputPath)}.tmp`);
  await writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  await rename(tmp, outputPath);
  return { status };
}

async function main() {
  const [existingPath, distributedPath, outputPath] = process.argv.slice(2);
  const res = await mergeCursorHooks(existingPath, distributedPath, outputPath || existingPath);
  if (res.status === 'conflict') {
    console.error(`Conflict: ${existingPath} ${res.reason}; upstream written to ${existingPath}.squad-upstream`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
