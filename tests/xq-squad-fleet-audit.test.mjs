import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const auditScript = join(root, "scripts", "xq-squad-fleet-audit.mjs");
const syncRunner = join(root, "scripts", "xq-squad-sync-runner.sh");

function runNode(args) {
  return spawnSync(process.execPath, [auditScript, ...args], {
    encoding: "utf8",
  });
}

test("xq-squad-fleet-audit requires --expected", () => {
  const result = runNode([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--expected is required/);
});

test("xq-squad-fleet-audit reports local .github installation", () => {
  const result = runNode(["--expected", "1.4.0", "--local-path", root, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.compliant, 1);
  assert.equal(payload.repositories[0].effectiveVersion, "1.4.0");
});

test("xq-squad-sync-runner validates version argument", () => {
  const result = spawnSync("bash", [syncRunner, root, "not-a-version"], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must match vX\.Y\.Z/);
});
