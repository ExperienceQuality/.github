import { readFile, access } from 'node:fs/promises';
import { createReadStream, lstatSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_BUDGET = 4000;
const DEFAULT_SOURCES = ['lessons.ndjson', 'delivery-events.ndjson'];

function resolveMemoryDir(explicit) {
  return explicit || process.env.SQUAD_MEMORY_DIR || '.squad/memory';
}

// A source must be a literal relative file path — no absolutes, traversal,
// backslashes, glob characters, control characters, or .git segments.
// The .git comparison is conservative: NFC + case-folded so case/Unicode
// aliases on permissive filesystems cannot slip a control path through.
function isValidSource(src) {
  return (
    typeof src === 'string' &&
    src.length > 0 &&
    src.length <= 4096 &&
    !path.isAbsolute(src) &&
    !src.includes('\\') &&
    !/[\x00-\x1f\x7f]/.test(src) &&
    !/[?*\[\]{}!]/.test(src) &&
    !src
      .split('/')
      .some(
        (s) =>
          s === '' ||
          s === '.' ||
          s === '..' ||
          s.normalize('NFC').toLowerCase() === '.git',
      )
  );
}

// Resolve a source inside memoryDir, refusing symlink escapes: the resolved
// path (or its nearest existing ancestor for not-yet-existing files) must
// stay inside the real memoryDir.
function resolveSourcePath(dir, src) {
  let root;
  try {
    root = realpathSync(dir);
  } catch (err) {
    // Only a genuinely absent dir falls back to lexical checks (reads then
    // return empty). Permission/IO failures and broken symlinks fail closed.
    if (err && err.code === 'ENOENT') return path.join(dir, src);
    return null;
  }
  const target = path.join(dir, src);
  let probe = target;
  for (;;) {
    try {
      const real = realpathSync(probe);
      if (real !== root && !real.startsWith(root + path.sep)) return null;
      return target;
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
      // realpath throws ENOENT for a dangling symlink as well as a truly
      // absent path — lstat sees the link itself, so refuse ambiguous aliases.
      try {
        if (lstatSync(probe).isSymbolicLink()) return null;
      } catch (lerr) {
        if (!lerr || lerr.code !== 'ENOENT') return null;
      }
      const parent = path.dirname(probe);
      if (parent === probe || parent === path.dirname(root)) return null;
      probe = parent;
    }
  }
}

function tokenEstimate(text) {
  // Very rough tokenizer estimate: ~4 characters per token for English/JSON text.
  return Math.ceil(text.length / 4);
}

function scoreRecord(record, keywords, types, explicitStatuses) {
  let score = 0;
  const hay = `${record.topic} ${record.summary} ${record.details || ''}`.toLowerCase();
  for (const kw of keywords) {
    if (hay.includes(kw.toLowerCase())) score += 3;
  }
  if (types.length && types.includes(record.type)) score += 2;
  if (explicitStatuses.length && explicitStatuses.includes(record.status)) score += 1;
  if (record.status === 'superseded') score -= 1;
  return score;
}

async function readNdjson(filePath) {
  const records = [];
  try {
    await access(filePath);
  } catch (err) {
    // Missing file reads as empty; permission/IO failures are not silent.
    if (err && err.code === 'ENOENT') return records;
    throw err;
  }
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch (e) {
      throw new Error(`Invalid JSON at line ${lineNumber} in ${filePath}: ${e.message}`);
    }
  }
  return records;
}

export async function searchMemory({ keywords = [], types = [], statuses = ['active'], budget = DEFAULT_BUDGET, sources = DEFAULT_SOURCES, memoryDir } = {}) {
  const dir = resolveMemoryDir(memoryDir);
  const all = [];
  for (const src of sources) {
    if (!isValidSource(src)) {
      throw new Error(`Invalid memory source: ${JSON.stringify(src)} — expected a literal relative file path`);
    }
    const resolved = resolveSourcePath(dir, src);
    if (resolved === null) {
      throw new Error(`Memory source escapes memoryDir: ${JSON.stringify(src)}`);
    }
    const records = await readNdjson(resolved);
    for (const rec of records) {
      all.push({ ...rec, _source: src });
    }
  }

  const explicitStatuses = statuses.length && !(statuses.length === 1 && statuses[0] === 'active') ? statuses : [];
  const hasFilter = keywords.length > 0 || types.length > 0 || explicitStatuses.length > 0;
  const scored = all
    .map(rec => ({ record: rec, score: scoreRecord(rec, keywords, types, explicitStatuses) }))
    .filter(item => item.score > 0 || !hasFilter)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  let used = 0;
  const references = [];

  for (const item of scored) {
    const text = JSON.stringify(item.record);
    const cost = tokenEstimate(text);
    if (used + cost > budget && selected.length > 0) break;
    selected.push(item.record);
    references.push(`${item.record.id} (${item.record._source})`);
    used += cost;
    delete item.record._source;
  }

  return {
    records: selected,
    references,
    used_budget: used,
    budget,
    approximate_tokens: used,
    total_considered: all.length
  };
}

const USAGE =
  'Usage: node memory-search.mjs <keywords...> [--type lesson|observation|delivery_event|decision] [--status active|superseded|historical|rejected] [--budget N] [--source <relative-file>]...';

// Parse CLI args; throws Error with a user-facing message on any invalid or
// missing value. --source is repeatable and replaces the default source list
// only when at least one is given.
export function parseSearchArgs(args) {
  const keywords = [];
  const types = [];
  const statuses = [];
  const sources = [];
  let budget = DEFAULT_BUDGET;

  const takeValue = (flag, i) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--type') types.push(takeValue(a, i++));
    else if (a === '--status') statuses.push(takeValue(a, i++));
    else if (a === '--source') sources.push(takeValue(a, i++));
    else if (a === '--budget') {
      const v = takeValue(a, i++);
      if (!/^\d+$/.test(v)) {
        throw new Error(`--budget must be a positive integer, got ${v}`);
      }
      budget = Number(v);
      if (!Number.isSafeInteger(budget) || budget <= 0) {
        throw new Error(`--budget must be a positive integer, got ${v}`);
      }
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option ${a}`);
    } else keywords.push(a);
  }
  for (const src of sources) {
    if (!isValidSource(src)) {
      throw new Error(`invalid --source ${JSON.stringify(src)} — expected a literal relative file path`);
    }
  }
  return {
    keywords,
    types,
    statuses,
    budget,
    sources: sources.length ? sources : DEFAULT_SOURCES,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = parseSearchArgs(args);
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  try {
    const result = await searchMemory({
      keywords: parsed.keywords,
      types: parsed.types,
      statuses: parsed.statuses.length ? parsed.statuses : ['active'],
      budget: parsed.budget,
      sources: parsed.sources,
      memoryDir: process.env.SQUAD_MEMORY_DIR,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(`memory search failed: ${err.message}`);
    process.exit(1);
  }
}

function isMain() {
  try {
    return (
      process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMain()) {
  main();
}
