// XQ Squad Cursor hook (preToolUse, Write|Delete). This adds to the shared
// claim helpers and does not replace them. A write that lands in an ACTIVE
// delivery worktree must stay inside that delivery's claimed scope. A session
// running inside a delivery worktree must not write outside it. Everything
// else is allowed, so serial use in the main checkout is unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStdinJson, respond, projectDir, deliveryIdOf, HOOK_ROOT } from './xq-squad-hook-io.mjs';

function targetPath(input) {
  const ti = input?.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const p = ti.file_path ?? ti.path ?? ti.target_file ?? input?.file_path;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

// realpath of the deepest existing ancestor, with the missing tail re-joined.
function realish(p) {
  let cur = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    cur = fs.realpathSync(cur);
  } catch {}
  return path.join(cur, ...tail);
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const deny = (why) => ({
  permission: 'deny',
  user_message: `XQ Squad scope guard: ${why}`,
  agent_message: `XQ Squad scope guard blocked this write: ${why}. Do not work around it; report BLOCKED to the Lead/user.`,
});

export async function decide(input, { helpersRoot = HOOK_ROOT } = {}) {
  const raw = targetPath(input);
  if (!raw) return { permission: 'allow' };
  const project = projectDir(input);
  const file = realish(path.isAbsolute(raw) ? raw : path.join(project, raw));
  const sessionDelivery = deliveryIdOf(realish(project));

  let helpers;
  try {
    const load = (m) => import(pathToFileURL(path.join(helpersRoot, '.squad', 'scripts', m)).href);
    helpers = { registry: await load('delivery-registry.mjs'), scope: await load('delivery-scope.mjs') };
  } catch {
    return sessionDelivery ? deny('delivery helpers unavailable inside a delivery worktree') : { permission: 'allow' };
  }

  const reg = await helpers.registry.readRegistry({ repositoryPath: realish(project) });
  if (reg.status !== 'OK') {
    return sessionDelivery || deliveryIdOf(file)
      ? deny(`claim registry is indeterminate (${reg.code})`)
      : { permission: 'allow' };
  }
  const active = reg.records.filter((r) => r.state === 'ACTIVE');

  if (sessionDelivery) {
    const own = active.find((r) => r.deliveryId === sessionDelivery);
    if (!own) return deny(`delivery ${sessionDelivery} has no ACTIVE claim`);
    if (!inside(file, own.worktreePath)) return deny(`${raw} is outside delivery worktree ${own.worktreePath}`);
  }

  const owner = active.find((r) => inside(file, r.worktreePath));
  if (!owner) {
    return deliveryIdOf(file) ? deny(`${raw} is in an unclaimed delivery worktree`) : { permission: 'allow' };
  }
  const res = await helpers.scope.validateWritePaths({ worktreePath: owner.worktreePath, paths: [file], scope: owner.scope });
  if (res.status === 'OK') return { permission: 'allow' };
  const reason = res.violations?.[0]?.reason || res.message || res.code;
  return deny(`${raw} is outside the claimed scope of ${owner.deliveryId} (${reason})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = await readStdinJson();
  let out;
  try {
    out = await decide(input);
  } catch (err) {
    out = deliveryIdOf(projectDir(input)) ? deny(`hook error: ${err.message}`) : { permission: 'allow' };
  }
  respond(out);
}
