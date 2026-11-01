// Shared stdin/stdout helpers for XQ Squad Cursor hooks.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function readStdinJson() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function respond(output) {
  process.stdout.write(JSON.stringify(output) + '\n');
}

export function projectDir(input) {
  const roots = Array.isArray(input?.workspace_roots) ? input.workspace_roots : [];
  return process.env.CURSOR_PROJECT_DIR || roots[0] || input?.cwd || process.cwd();
}

// Root of the checkout that ships this hook (<root>/.cursor/hooks/<file>).
export const HOOK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Delivery id when dir is inside <repo>/.squad/worktrees/<id>, else null.
export function deliveryIdOf(dir) {
  const m = /[\\/]\.squad[\\/]worktrees[\\/]([a-z0-9]+(?:-[a-z0-9]+)*)(?:[\\/]|$)/.exec(dir || '');
  return m ? m[1] : null;
}
