#!/usr/bin/env node
/**
 * Audit ExperienceQuality repositories for installed XQ Squad version.
 * Reads .squad/squad.json and .squad/install-state.json via the GitHub Contents API.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_REPOS = [
  "xq-fitness-app",
  "xq-financial-app",
  "jvm-test-kit",
  "xq-xcuitest-support",
  "xq-svc-exercice",
  "xq-platform",
  "xq-svc-routine",
  "xq-exercices-miniapp",
  "xq-hub",
  "xq-aegis",
  "xq-luthor",
  "xq-jewy",
  "xq-fitness-bff",
  ".github",
];

function parseArgs(argv) {
  const options = {
    org: "ExperienceQuality",
    expected: "",
    repos: [...DEFAULT_REPOS],
    json: false,
    localPath: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--org") {
      options.org = argv[++index];
    } else if (arg === "--expected") {
      options.expected = argv[++index];
    } else if (arg === "--repos") {
      options.repos = argv[++index].split(",").map((item) => item.trim()).filter(Boolean);
    } else if (arg === "--local-path") {
      options.localPath = argv[++index];
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/xq-squad-fleet-audit.mjs --expected 1.4.0 [--org OWNER] [--repos a,b] [--json]`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.expected) {
    throw new Error("--expected is required (semver without v prefix, e.g. 1.4.0)");
  }
  return options;
}

function ghApi(path) {
  const result = spawnSync("gh", ["api", path, "-q", ".content"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return null;
  }
  const encoded = result.stdout.trim();
  if (!encoded) {
    return null;
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

function readVersion(raw) {
  if (!raw) {
    return "";
  }
  try {
    return String(JSON.parse(raw).version ?? "");
  } catch {
    return "";
  }
}

function readLocalJson(root, relativePath) {
  try {
    return readFileSync(join(root, relativePath), "utf8");
  } catch {
    return null;
  }
}

function auditRepo(org, repo, localRoot = "") {
  let squadRaw = null;
  let installRaw = null;
  if (localRoot) {
    squadRaw = readLocalJson(localRoot, ".squad/squad.json");
    installRaw = readLocalJson(localRoot, ".squad/install-state.json");
  } else {
    const base = `repos/${org}/${repo}/contents`;
    squadRaw = ghApi(`${base}/.squad/squad.json`);
    installRaw = ghApi(`${base}/.squad/install-state.json`);
  }
  const squadVersion = readVersion(squadRaw);
  const installVersion = readVersion(installRaw);
  const effective = squadVersion || installVersion;
  let status = "missing";
  if (effective) {
    status = "installed";
  }
  return {
    repository: `${org}/${repo}`,
    squadVersion,
    installVersion,
    effectiveVersion: effective,
    status,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const rows = options.localPath
    ? [auditRepo(options.org, ".github", options.localPath)]
    : options.repos.map((repo) => auditRepo(options.org, repo));
  const behind = rows.filter((row) => row.effectiveVersion !== options.expected);
  const summary = {
    expected: options.expected,
    total: rows.length,
    compliant: rows.length - behind.length,
    nonCompliant: behind.length,
    repositories: rows,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const row of rows) {
      const marker = row.effectiveVersion === options.expected ? "ok" : "NEEDS_SYNC";
      console.log(
        `${row.repository}: effective=${row.effectiveVersion || "-"} squad.json=${row.squadVersion || "-"} install-state=${row.installVersion || "-"} ${marker}`,
      );
    }
    console.log(`\nExpected v${options.expected}: ${summary.compliant}/${summary.total} compliant`);
  }

  if (behind.length > 0) {
    process.exit(1);
  }
}

main();
