import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectBuildArtifacts,
  packageManagerCommand,
  readManifest,
  resolveSafeDirectory,
  validateLockfile,
  validateGitHubPackageName,
  validatePackageManager,
  compareSemver,
  parsePackageDirectories,
  publishDecision,
  validatePrepare,
  validatePublishablePackage,
  validateRepositoryMetadata,
  validateScript,
} from "../scripts/node-runner.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name) => join(root, "tests", "fixtures", name);

function runBlocks(workflow) {
  const lines = workflow.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*\|\s*$/);
    if (!match) continue;
    const indent = match[1].length;
    const block = [];
    for (index += 1; index < lines.length; index += 1) {
      const nextIndent = lines[index].match(/^\s*/)[0].length;
      if (lines[index].trim() !== "" && nextIndent <= indent) {
        index -= 1;
        break;
      }
      block.push(lines[index]);
    }
    blocks.push(block.join("\n"));
  }
  return blocks;
}

test("npm contract fixture has strict lockfile and required scripts", () => {
  const directory = fixture("npm");
  assert.equal(validatePackageManager("npm"), "npm");
  assert.equal(validateLockfile(directory, "npm"), "package-lock.json");
  const manifest = readManifest(directory);
  for (const script of ["ci:build", "ci:test", "ci:release"]) validateScript(manifest, script);
  assert.deepEqual(packageManagerCommand("npm", "install"), ["npm", ["ci"]]);
});

test("pnpm contract fixture has frozen lockfile and required scripts", () => {
  const directory = fixture("pnpm");
  assert.equal(validatePackageManager("pnpm"), "pnpm");
  assert.equal(validateLockfile(directory, "pnpm"), "pnpm-lock.yaml");
  const manifest = readManifest(directory);
  for (const script of ["ci:build", "ci:test", "ci:release"]) validateScript(manifest, script);
  assert.deepEqual(packageManagerCommand("pnpm", "install"), ["corepack", ["pnpm", "install", "--frozen-lockfile"]]);
});

test("build contract collects only caller-produced artifacts/*.tgz packages", () => {
  for (const manager of ["npm", "pnpm"]) {
    const manifest = readManifest(fixture(manager));
    assert.match(manifest.scripts["ci:build"], /artifacts\//);
  }
  const workspace = mkdtempSync(join(tmpdir(), "xq-build-contract-"));
  const output = mkdtempSync(join(tmpdir(), "xq-build-output-"));
  mkdirSync(join(workspace, "artifacts"));
  writeFileSync(join(workspace, "artifacts", "example-1.0.0.tgz"), "fixture");
  writeFileSync(join(workspace, "artifacts", "ignore.txt"), "fixture");
  collectBuildArtifacts(workspace, output);
  assert.equal(readFileSync(join(output, "example-1.0.0.tgz"), "utf8"), "fixture");
  assert.throws(
    () => collectBuildArtifacts(mkdtempSync(join(tmpdir(), "xq-missing-artifacts-")), output),
    /build artifact directory does not exist/,
  );
});

test("invalid package managers are rejected", () => {
  assert.throws(() => validatePackageManager("yarn"), /must be npm or pnpm/);
  assert.throws(() => validatePackageManager("npm && env"), /must be npm or pnpm/);
});

test("unsafe and escaping package paths are rejected", () => {
  const directory = fixture("npm");
  assert.throws(() => resolveSafeDirectory(directory, "../pnpm"), /unsafe path segment/);
  assert.throws(() => resolveSafeDirectory(directory, "/tmp"), /relative POSIX path/);
  assert.throws(() => resolveSafeDirectory(directory, "missing"), /does not exist/);
});

test("missing contract scripts are rejected", () => {
  assert.throws(() => validateScript({ scripts: {} }, "ci:release"), /missing required ci:release script/);
});

test("publish metadata accepts package identity and dist-tags", () => {
  assert.deepEqual(
    validatePublishablePackage({ name: "@experiencequality/example", version: "1.2.3" }),
    { name: "@experiencequality/example", version: "1.2.3", distTag: "latest" },
  );
  assert.equal(validatePublishablePackage({ name: "example", version: "1.2.3+build-5" }).distTag, "latest");
  assert.equal(validatePublishablePackage({ name: "example", version: "1.2.3-beta.1+build-5" }).distTag, "next");
});

test("publish metadata rejects wrong identity, private package, and bad version", () => {
  const manifest = { name: "example", version: "1.2.3" };
  assert.throws(
    () => validatePublishablePackage(manifest, "other"),
    /unexpected package identity/,
  );
  assert.throws(
    () => validatePublishablePackage({ ...manifest, private: true }),
    /private and cannot be published/,
  );
  assert.throws(
    () => validatePublishablePackage({ ...manifest, version: "latest" }),
    /valid semantic version/,
  );
});

test("publish compares local package.json version to the registry", () => {
  assert.equal(compareSemver("1.0.6", "1.0.5"), 1);
  assert.equal(publishDecision("1.0.6", "1.0.5"), "publish");
  assert.equal(publishDecision("1.0.5", "1.0.5"), "skip");
  assert.equal(publishDecision("1.0.4", "1.0.5"), "downgrade");
  assert.equal(publishDecision("1.0.0", null), "publish");
  assert.deepEqual(parsePackageDirectories("packages/core\npackages/db"), ["packages/core", "packages/db"]);
  assert.deepEqual(parsePackageDirectories(""), ["."]);
  assert.equal(validatePrepare("none"), "none");
  assert.throws(() => validatePrepare("rm -rf /"), /prepare must be ci:build or none/);
});

test("repository metadata must match trusted caller repository", () => {
  assert.equal(
    validateRepositoryMetadata(
      { repository: { type: "git", url: "git+https://github.com/ExperienceQuality/xq-test-platform.git" } },
      "ExperienceQuality/xq-test-platform",
    ),
    "https://github.com/ExperienceQuality/xq-test-platform",
  );
  assert.equal(
    validateRepositoryMetadata(
      { repository: "https://github.com/ExperienceQuality/xq-test-platform" },
      "ExperienceQuality/xq-test-platform",
    ),
    "https://github.com/ExperienceQuality/xq-test-platform",
  );
  assert.throws(
    () => validateRepositoryMetadata({ repository: "https://github.com/attacker/project" }, "ExperienceQuality/xq-test-platform"),
    /must match caller repository/,
  );
  assert.throws(
    () => validateRepositoryMetadata({}, "ExperienceQuality/xq-test-platform"),
    /must declare repository/,
  );
});

test("GitHub Packages requires caller-owner scope", () => {
  assert.equal(validateGitHubPackageName("@experiencequality/example", "ExperienceQuality/xq-test-platform"), "@experiencequality/example");
  assert.throws(
    () => validateGitHubPackageName("example", "ExperienceQuality/xq-test-platform"),
    /requires package name scoped to @experiencequality\//,
  );
  assert.throws(
    () => validateGitHubPackageName("@other/example", "ExperienceQuality/xq-test-platform"),
    /requires package name scoped to @experiencequality\//,
  );
});

test("workflows pin actions, avoid long-lived tokens, and keep least privilege", () => {
  const workflows = ["node-build.yml", "node-test.yml", "node-publish.yml"]
    .map((name) => readFileSync(join(root, ".github", "workflows", name), "utf8"));
  const combined = workflows.join("\n");
  assert.doesNotMatch(combined, /NPM_TOKEN|secrets:\s*inherit|id-token:\s*write/);
  for (const workflow of workflows) {
    for (const block of runBlocks(workflow)) assert.doesNotMatch(block, /\$\{\{\s*inputs\./);
  }
  assert.doesNotMatch(combined, /github\.workflow_sha/);
  assert.equal([...combined.matchAll(/repository: \$\{\{ job\.workflow_repository \}\}\n\s+ref: \$\{\{ job\.workflow_sha \}\}/g)].length, 3);
  for (const match of combined.matchAll(/uses:\s+(actions\/[\w-]+)@([^\s#]+)/g)) {
    assert.match(match[2], /^[0-9a-f]{40}$/, `${match[1]} must use a full commit SHA`);
  }
  assert.match(workflows[0], /permissions:\n  contents: read/);
  assert.match(workflows[1], /permissions:\n  contents: read/);
  assert.doesNotMatch(workflows[1], /id-token: write/);
  assert.match(workflows[2], /permissions:\n  contents: read\n  packages: write/);
  assert.match(workflows[2], /NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  const runner = readFileSync(join(root, "scripts", "node-runner.mjs"), "utf8");
  assert.match(runner, /"publish",\s+tarball,\s+"--tag"/);
  assert.match(runner, /"--tag",\s+metadata\.distTag/);
  assert.match(runner, /"--registry",\s+"https:\/\/npm\.pkg\.github\.com"/);
});

test("workflow templates are thin v1 callers with one stage marker each", () => {
  for (const stage of ["build", "test", "publish"]) {
    const template = readFileSync(join(root, "workflow-templates", `node-${stage}.yml`), "utf8");
    assert.match(template, new RegExp(`uses: ExperienceQuality\\/.github\\/.github\\/workflows\\/node-${stage}\\.yml@v1`));
    assert.equal([...template.matchAll(/# hub-stage:/g)].length, 1);
  }
});
