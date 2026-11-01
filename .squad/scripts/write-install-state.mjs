import { writeFile, mkdir } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const MANAGED_PREFIXES = ['.devin/', '.squad/', '.cursor/'];

async function hashFile(path) {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function listFiles(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    const entries = await import('node:fs/promises').then(m => m.readdir(current, { withFileTypes: true }));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else {
        files.push(path);
      }
    }
  }
  return files.sort();
}

export async function writeInstallState(targetDir, version, extractDir) {
  const squadDir = join(targetDir, '.squad');
  await mkdir(squadDir, { recursive: true });

  const managedFiles = {};
  const files = await listFiles(extractDir);
  for (const file of files) {
    const rel = relative(extractDir, file);
    if (rel === 'AGENTS.md') {
      managedFiles[rel] = await hashFile(file);
      continue;
    }
    if (!MANAGED_PREFIXES.some((p) => rel.startsWith(p))) continue;
    const installed = join(targetDir, rel);
    if (rel === '.cursor/hooks.json') {
      // Merge-managed: record the merged result actually on disk.
      managedFiles[rel] = await hashFile(existsSync(installed) ? installed : file);
      continue;
    }
    const hash = await hashFile(file);
    // A pre-existing consumer file kept at install time stays consumer-owned.
    if (existsSync(installed) && (await hashFile(installed)) !== hash) continue;
    managedFiles[rel] = hash;
  }

  const squadJsonPath = join(extractDir, '.squad', 'squad.json');
  const squadJson = JSON.parse(await readFile(squadJsonPath, 'utf8'));

  const versionNumber = version.startsWith('v') ? version.slice(1) : version;
  const state = {
    version: versionNumber,
    release_tag: squadJson.release_tag,
    config_schema_version: squadJson.config_schema_version,
    memory_schema_version: squadJson.memory_schema_version,
    installed_at: new Date().toISOString(),
    managed_files: managedFiles,
    ownership: squadJson.ownership
  };

  await writeFile(join(squadDir, 'install-state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

async function main() {
  const [targetDir, version, extractDir] = process.argv.slice(2);
  await writeInstallState(targetDir, version, extractDir);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
