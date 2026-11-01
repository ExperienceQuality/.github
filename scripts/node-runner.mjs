#!/usr/bin/env node

import { copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function validatePackageManager(value) {
  if (value !== "npm" && value !== "pnpm") {
    throw new Error(`package-manager must be npm or pnpm; received ${JSON.stringify(value)}`);
  }
  return value;
}

export function resolveSafeDirectory(workspace, value, label = "directory") {
  if (!value || isAbsolute(value) || value.includes("\\")) {
    throw new Error(`${label} must be a relative POSIX path`);
  }
  if (value !== ".") {
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || !PATH_SEGMENT.test(segment))) {
      throw new Error(`${label} contains an unsafe path segment`);
    }
  }

  const root = realpathSync(workspace);
  const candidate = resolve(root, value);
  if (!existsSync(candidate)) {
    throw new Error(`${label} does not exist: ${value}`);
  }
  const target = realpathSync(candidate);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes the checked-out repository`);
  }
  return target;
}

export function readManifest(directory) {
  const path = join(directory, "package.json");
  if (!existsSync(path)) throw new Error(`missing package.json in ${directory}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateScript(manifest, scriptName) {
  if (typeof manifest.scripts?.[scriptName] !== "string" || manifest.scripts[scriptName].trim() === "") {
    throw new Error(`missing required ${scriptName} script`);
  }
}

export function validateLockfile(workspace, packageManager) {
  const expected = packageManager === "npm" ? "package-lock.json" : "pnpm-lock.yaml";
  if (!existsSync(join(workspace, expected))) {
    throw new Error(`${packageManager} requires ${expected} at repository root`);
  }
  return expected;
}

export function validatePublishMetadata({ manifest, packageName, tagPrefix, gitRef }) {
  if (!PACKAGE_NAME.test(packageName)) throw new Error("package-name is not a valid lowercase npm package name");
  if (!PACKAGE_NAME.test(tagPrefix) || tagPrefix.startsWith("@")) {
    throw new Error("tag-prefix must be an unscoped lowercase npm-style name");
  }
  if (manifest.name !== packageName) {
    throw new Error(`unexpected package identity: expected ${packageName}, found ${String(manifest.name)}`);
  }
  if (manifest.private === true) throw new Error(`${packageName} is private and cannot be published`);
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
    throw new Error(`${packageName} must have a valid semantic version`);
  }
  const expectedRef = `refs/tags/${tagPrefix}@${manifest.version}`;
  if (gitRef !== expectedRef) {
    throw new Error(`tag mismatch: expected ${expectedRef}, received ${gitRef}`);
  }
  const distTag = manifest.version.split("+")[0].includes("-") ? "next" : "latest";
  return { name: packageName, version: manifest.version, expectedRef, distTag };
}

export function validateRepositoryMetadata(manifest, githubRepository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepository)) {
    throw new Error("GitHub caller repository has an invalid owner/repository shape");
  }
  const value = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  if (typeof value !== "string") throw new Error("package manifest must declare repository as an HTTPS GitHub URL");
  const normalized = value.replace(/^git\+/, "").replace(/\.git$/, "").replace(/\/$/, "");
  const expected = `https://github.com/${githubRepository}`;
  if (normalized.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`package repository must match caller repository ${expected}`);
  }
  return expected;
}

export function validateGitHubPackageName(packageName, githubRepository) {
  const [owner] = githubRepository.split("/");
  const expectedScope = `@${owner.toLowerCase()}/`;
  if (!packageName.startsWith(expectedScope)) {
    throw new Error(`GitHub Packages requires package name scoped to ${expectedScope}`);
  }
  return packageName;
}

export function packageManagerCommand(packageManager, operation) {
  validatePackageManager(packageManager);
  const runCommand = packageManager === "npm" ? "npm" : "corepack";
  const runPrefix = packageManager === "npm" ? [] : ["pnpm"];
  const commands = {
    install: packageManager === "npm" ? ["npm", ["ci"]] : ["corepack", ["pnpm", "install", "--frozen-lockfile"]],
    build: [runCommand, [...runPrefix, "run", "ci:build"]],
    test: [runCommand, [...runPrefix, "run", "ci:test"]],
    release: [runCommand, [...runPrefix, "run", "ci:release"]],
  };
  if (!commands[operation]) throw new Error(`unsupported operation: ${operation}`);
  return commands[operation];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result.stdout.trim();
}

function installDependencies(workspace, packageManager) {
  validateLockfile(workspace, packageManager);
  const [command, args] = packageManagerCommand(packageManager, "install");
  run(command, args, { cwd: workspace });
}

function runContract(workspace, packageManager, scriptName) {
  const manifest = readManifest(workspace);
  validateScript(manifest, scriptName);
  const operation = scriptName.slice(3);
  const [command, args] = packageManagerCommand(packageManager, operation);
  run(command, args, { cwd: workspace });
}

function pack(directory, destination) {
  const output = capture("npm", ["pack", ".", "--json", "--ignore-scripts", "--pack-destination", destination], {
    cwd: directory,
  });
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0]?.filename !== "string") {
    throw new Error("npm pack did not produce exactly one tarball");
  }
  return join(destination, basename(parsed[0].filename));
}

export function collectBuildArtifacts(workingDirectory, destination) {
  const artifactRoot = resolveSafeDirectory(workingDirectory, "artifacts", "build artifact directory");
  const tarballs = readdirSync(artifactRoot).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length === 0) throw new Error("ci:build must produce at least one artifacts/*.tgz file");
  mkdirSync(destination, { recursive: true });
  for (const name of tarballs) {
    const source = join(artifactRoot, name);
    if (!lstatSync(source).isFile()) throw new Error(`build artifact must be a regular file: ${name}`);
    copyFileSync(source, join(destination, name));
  }
}

function ensureClean(workspace) {
  const status = capture("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: workspace });
  if (status !== "") throw new Error(`ci:release left generated output dirty:\n${status}`);
}

function verifyTarball(tarball, metadata) {
  const consumer = mkdtempSync(join(tmpdir(), "xq-node-library-consumer-"));
  run("npm", ["init", "--yes"], { cwd: consumer });
  run("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: consumer });
  const tree = JSON.parse(capture("npm", ["ls", "--depth=0", "--json"], { cwd: consumer }));
  const installed = tree.dependencies?.[metadata.name];
  if (installed?.version !== metadata.version) {
    throw new Error(`clean consumer did not install ${metadata.name}@${metadata.version}`);
  }
}

function parseArguments(argv) {
  const [operation, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument near ${String(key)}`);
    values[key.slice(2)] = value;
  }
  return { operation, values };
}

export function main(argv = process.argv.slice(2)) {
  const { operation, values } = parseArguments(argv);
  if (!['build', 'test', 'publish'].includes(operation)) throw new Error("operation must be build, test, or publish");

  const packageManager = validatePackageManager(values["package-manager"]);
  const workspace = realpathSync(values.workspace);

  if (operation === "build" || operation === "test") {
    const workingDirectory = resolveSafeDirectory(workspace, values["working-directory"], "working-directory");
    installDependencies(workspace, packageManager);
    runContract(workingDirectory, packageManager, `ci:${operation}`);
    if (operation === "build") {
      const destination = resolve(values["artifact-directory"]);
      collectBuildArtifacts(workingDirectory, destination);
    }
    return;
  }

  const packageDirectory = resolveSafeDirectory(workspace, values["package-directory"], "package-directory");
  const manifest = readManifest(packageDirectory);
  const metadata = validatePublishMetadata({
    manifest,
    packageName: values["package-name"],
    tagPrefix: values["tag-prefix"],
    gitRef: values["git-ref"],
  });
  validateRepositoryMetadata(manifest, values["github-repository"]);
  validateGitHubPackageName(metadata.name, values["github-repository"]);
  installDependencies(workspace, packageManager);
  runContract(workspace, packageManager, "ci:release");
  ensureClean(workspace);
  const artifactDirectory = resolve(values["artifact-directory"]);
  const tarball = pack(packageDirectory, artifactDirectory);
  verifyTarball(tarball, metadata);
  run("npm", ["publish", tarball, "--tag", metadata.distTag, "--registry", "https://npm.pkg.github.com"], {
    cwd: workspace,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
