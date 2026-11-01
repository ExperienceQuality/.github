// XQ Squad Cursor hook (stop). In a delivery worktree with uncommitted
// changes, send one follow-up so VERIFICATION and MEMORY_UPDATE are reported
// before the delivery ends. It never loops (loop_limit 1 in hooks.json, and
// loop_count is checked here).
import { execFileSync } from 'node:child_process';
import { readStdinJson, respond, projectDir, deliveryIdOf } from './xq-squad-hook-io.mjs';

export function decide(input, { gitStatus } = {}) {
  if (input?.status !== 'completed' || (input?.loop_count ?? 0) > 0) return {};
  const dir = projectDir(input);
  const id = deliveryIdOf(dir);
  if (!id) return {};
  let dirty = '';
  try {
    dirty = gitStatus ? gitStatus(dir) : execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
  } catch {
    return {};
  }
  if (!dirty.trim()) return {};
  return {
    followup_message:
      `XQ Squad delivery ${id} has uncommitted changes. Before finishing, confirm the VERIFICATION stage ` +
      '(checks run and their observed results, plus delivery-verify write verification) and report memory status ' +
      '(UPDATED, UNCHANGED, or BLOCKED), per .squad/workflows/delivery.md. If already reported, reply "done".',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let out = {};
  try {
    out = decide(await readStdinJson());
  } catch {}
  respond(out);
}
