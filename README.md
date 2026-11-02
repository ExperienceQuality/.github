# ExperienceQuality organization automation

Reusable GitHub Actions workflows and organization workflow templates for publishable Node.js modules.

## Shared workflows

| Workflow | Purpose |
|----------|---------|
| `node-build.yml` | Install, run `ci:build`, upload `artifacts/*.tgz` |
| `node-test.yml` | Install, run `ci:test` |
| `node-publish.yml` | Publish to GitHub Packages when `package.json` version is newer than the registry |

## Consumer contract

Consumer repositories keep triggers, permissions, and package policy in thin caller workflows. Callers use the protected major tag:

```yaml
jobs:
  build:
    uses: ExperienceQuality/.github/.github/workflows/node-build.yml@v1
    with:
      node-version: "24"
      package-manager: npm
      working-directory: .
```

Supported package managers are exactly `npm` and `pnpm`. Dependencies are installed from the repository-root `package-lock.json` with `npm ci`, or `pnpm-lock.yaml` with `pnpm install --frozen-lockfile`. Paths must be relative, must exist, and cannot escape the checkout.

- Build runs `ci:build` in `working-directory`. That script must create one or more packed packages at `artifacts/*.tgz`; those exact files become the workflow artifact.
- Test runs `ci:test` in `working-directory`.
- Publish installs at repository root, optionally runs `ci:build` (`prepare: ci:build` or `none`), then for each `package-directories` entry compares `package.json` version to GitHub Packages. Newer versions pack, verify in a clean consumer, and publish. Equal versions skip. Older versions fail. Optional `package-names` must match each directory. Stable versions use npm dist-tag `latest`; SemVer prereleases use `next`. Callers cannot override registry, token, or shell commands.

Commands are fixed by these contracts. Callers cannot supply shell fragments, install commands, test commands, or publish commands.

### Breaking change (hub v1.1.0+)

Reusable workflow paths were renamed from `node-library-*` to **`node-build`**, **`node-test`**, and **`node-publish`**. Publish is no longer tag-gated; it publishes when the local package version is greater than the version on GitHub Packages.

## GitHub Packages publishing

Publish callers must grant only:

```yaml
permissions:
  contents: read
  packages: write
```

The reusable workflow publishes with the caller's short-lived `GITHUB_TOKEN` to `https://npm.pkg.github.com`. Do not provide `NPM_TOKEN` or inherit secrets. Configure package visibility and repository access in GitHub Packages; no public npm registry approval step is used.

The publish workflow defaults to Node.js 24 and uses the GitHub Packages npm registry. Packages must use the caller-owner scope (for example `@experiencequality/example`).

### Package bootstrap prerequisite

The first GitHub Packages publication creates the package with the registry's default visibility. An authorized maintainer must configure the desired visibility and repository access in GitHub before consumers install it. This repository never changes package visibility automatically.

## Release policy

- Create immutable release tags such as `v1.0.0` for every central workflow release.
- Move protected major tag `v1` only through maintainer-approved release changes after validation.
- Restrict creation and update of `v1` and `v1.x.y` tags to approved maintainers.
- Roll back consumers by moving `v1` to a previously validated immutable tag, or pinning a caller to that immutable tag while investigating.
- Never create package tags or approve npm staging as part of central workflow release validation.

Reusable workflows check out their helper implementation from `${{ job.workflow_repository }}` at `${{ job.workflow_sha }}`. This couples helper code to the exact called workflow revision and avoids caller-SHA confusion. These `job` context properties require GitHub.com; GitHub Enterprise Server compatibility is not claimed.

## Templates and validation

`workflow-templates/` contains thin build, test, and GitHub Packages publish callers (`node-build`, `node-test`, `node-publish`). Replace publish template package policy before use. Validate changes with:

```sh
node --test tests/*.test.mjs
ruby -e 'require "yaml"; Dir[".github/workflows/*.yml", "workflow-templates/*.yml"].each { |file| YAML.load(File.read(file)) }'
git diff --check
```
