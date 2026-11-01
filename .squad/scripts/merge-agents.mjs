import { readFile, writeFile } from 'node:fs/promises';

const MANAGED_START = '<!-- XQ_SQUAD_MANAGED_START';
const MANAGED_END = '<!-- XQ_SQUAD_MANAGED_END -->';
const LEGACY_LEAD_BLOCK = `# XQ Squad

You are the **Agent Lead** for this repository. Operate from \`.squad/agents/lead.md\` and the delivery workflow in \`.squad/workflows/delivery.md\`. Use the \`squad-delivery\` skill when it helps.

- Read \`.squad/README.md\` for layout and conventions.
- Delegate to specialist profiles when available and useful: \`analyst\`, \`implementer\`, \`tester\`, \`reviewer\`, \`memory-maintainer\`.
- Load only relevant shared memory. Do not load all memory by default.
- Verify changes before reporting success.
- Run memory maintenance before delivery. Report \`UPDATED\`, \`UNCHANGED\`, or \`BLOCKED\`.
- Never push, commit, or open a PR unless explicitly authorized.`;

function stripManagedSection(content) {
  const startIdx = content.indexOf(MANAGED_START);
  if (startIdx === -1) return content;
  const endIdx = content.indexOf(MANAGED_END, startIdx);
  if (endIdx === -1) return content.slice(0, startIdx);
  return content.slice(0, startIdx) + content.slice(endIdx + MANAGED_END.length);
}

function extractManagedSection(content) {
  const startIdx = content.indexOf(MANAGED_START);
  if (startIdx === -1) return null;
  const endIdx = content.indexOf(MANAGED_END, startIdx);
  if (endIdx === -1) return null;
  return content.slice(startIdx, endIdx + MANAGED_END.length);
}

function normalizeConsumerContent(content) {
  return content
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*){3,}/g, '\n\n')
    .replace(/\s*$/, '');
}

export function mergeAgentsContent(existing, distributed) {
  const newManaged = extractManagedSection(distributed);
  if (!newManaged) throw new Error('Distributed AGENTS.md is missing a managed section');

  let consumerContent = stripManagedSection(existing);
  if (consumerContent.includes(LEGACY_LEAD_BLOCK)) {
    consumerContent = normalizeConsumerContent(consumerContent.replace(LEGACY_LEAD_BLOCK, ''));
  }

  if (!consumerContent.trim()) return `${newManaged}\n`;
  return `${consumerContent.replace(/\s*$/, '')}\n\n${newManaged}\n`;
}

export async function mergeAgents(existingPath, distributedPath, outputPath) {
  const existing = await readFile(existingPath, 'utf8');
  const distributed = await readFile(distributedPath, 'utf8');
  await writeFile(outputPath, mergeAgentsContent(existing, distributed), 'utf8');
}

async function main() {
  const [existingPath, distributedPath, outputPath] = process.argv.slice(2);
  await mergeAgents(existingPath, distributedPath, outputPath);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
