import { readFile, writeFile, rename, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';

function resolveSchemaPath(explicit) {
  return explicit || process.env.SQUAD_SCHEMA || '.squad/schemas/memory-record.schema.json';
}

async function loadSchema(explicitPath) {
  const raw = await readFile(resolveSchemaPath(explicitPath), 'utf8');
  return JSON.parse(raw);
}

function validateAgainstSchema(record, schema) {
  const errors = [];
  if (!record || typeof record !== 'object') {
    errors.push('Record is not an object');
    return errors;
  }
  for (const req of schema.required || []) {
    if (!(req in record)) errors.push(`Missing required field: ${req}`);
  }
  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (!(key in record)) continue;
      const val = record[key];
      if (prop.type && typeof val !== prop.type && !(prop.type === 'array' && Array.isArray(val))) {
        errors.push(`Field ${key} expected ${prop.type}, got ${typeof val}`);
      }
      if (prop.enum && !prop.enum.includes(val)) {
        errors.push(`Field ${key} must be one of ${prop.enum.join(', ')}, got ${val}`);
      }
      if (prop.maxLength && typeof val === 'string' && val.length > prop.maxLength) {
        errors.push(`Field ${key} exceeds maxLength ${prop.maxLength}`);
      }
      if (prop.pattern && typeof val === 'string' && !new RegExp(prop.pattern).test(val)) {
        errors.push(`Field ${key} does not match pattern ${prop.pattern}`);
      }
    }
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) errors.push(`Unexpected field: ${key}`);
    }
  }
  return errors;
}

async function readExistingRecords(filePath) {
  const records = new Map();
  try {
    await access(filePath);
  } catch {
    return records;
  }
  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`Invalid JSON at line ${lineNumber}: ${e.message}`);
    }
    if (!rec.id) throw new Error(`Record missing id at line ${lineNumber}`);
    if (records.has(rec.id)) throw new Error(`Duplicate id ${rec.id} at line ${lineNumber}`);
    records.set(rec.id, { record: rec, line: lineNumber });
  }
  return records;
}

async function atomicWrite(filePath, content) {
  const dir = dirname(filePath);
  const tmp = join(dir, `.${filePath.split('/').pop()}.tmp`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);
}

export async function updateMemory(inputPath, outputPath, options = {}) {
  const schema = await loadSchema(options.schemaPath);
  const inputLines = (await readFile(inputPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  const candidates = [];
  const errors = [];

  for (let i = 0; i < inputLines.length; i++) {
    const line = inputLines[i];
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      errors.push(`Line ${i + 1}: invalid JSON (${e.message})`);
      continue;
    }
    const validationErrors = validateAgainstSchema(rec, schema);
    if (validationErrors.length) {
      errors.push(`Line ${i + 1}: ${validationErrors.join('; ')}`);
      continue;
    }
    candidates.push(rec);
  }

  if (errors.length && !options.force) {
    return { ok: false, errors };
  }

  const existing = await readExistingRecords(outputPath);
  const seen = new Set();
  const now = new Date().toISOString();

  for (const rec of candidates) {
    if (seen.has(rec.id)) {
      errors.push(`Duplicate candidate id ${rec.id}`);
      if (!options.force) return { ok: false, errors };
      continue;
    }
    seen.add(rec.id);

    const current = existing.get(rec.id);
    if (current) {
      if (rec.status === 'active' && current.record.status === 'active') {
        errors.push(`Active id ${rec.id} already exists; use supersede or update`);
        if (!options.force) return { ok: false, errors };
        continue;
      }
    }

    if (!rec.updated_at) rec.updated_at = now;
  }

  for (const rec of candidates) {
    existing.set(rec.id, { record: rec });
  }

  const lines = [];
  for (const { record } of existing.values()) {
    lines.push(JSON.stringify(record));
  }

  await atomicWrite(outputPath, lines.join('\n') + (lines.length ? '\n' : ''));
  return { ok: true, updated: candidates.length, total: existing.size, errors: errors.length ? errors : undefined };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: node memory-update.mjs <candidate.ndjson> <target.ndjson> [--force]');
    process.exit(2);
  }
  const [inputPath, outputPath] = args;
  const force = args.includes('--force');
  const result = await updateMemory(inputPath, outputPath, { force, schemaPath: process.env.SQUAD_SCHEMA });
  if (!result.ok) {
    console.error('Validation failed:');
    for (const e of result.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log(`Updated ${result.updated} records. Total: ${result.total}.`);
  if (result.errors) {
    console.warn('Warnings:');
    for (const e of result.errors) console.warn(`  ${e}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
