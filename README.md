# ExperienceQuality organization automation

Reusable GitHub Actions workflows and organization workflow templates for publishable Node.js libraries.

## Consumer contract

Consumer repositories keep triggers, permissions, and package policy in thin caller workflows. Callers use the protected major tag:

```yaml
jobs:
  build:
    uses: ExperienceQuality/.github/.github/workflows/node-library-build.yml@v1
    with:
      node-version: "24"
      package-manager: npm
      working-directory: .
```

Supported package managers are exactly `npm` and `pnpm`. Dependencies are installed from the repository-root `package-lock.json` with `npm ci`, or `pnpm-lock.yaml` with `pnpm install --frozen-lockfile`. Paths must be relative, must exist, and cannot escape the checkout.

- Build runs `ci:build` in `working-directory`. That script must create one or more packed packages at `artifacts/*.tgz`; those exact files become the workflow artifact.
- Test runs `ci:test` in `working-directory`.
- Publish installs at repository root and runs root `ci:release`. It requires an exact `<tag-prefix>@<package.json version>` Git tag, exact package identity, a non-private package, an HTTPS `repository` URL matching the caller's GitHub repository, and a clean Git tree after release generation. It packs once, installs that tarball in a clean consumer, verifies name and version, then publishes the same tarball to GitHub Packages. Stable versions use npm dist-tag `latest`; SemVer prereleases use `next`. Callers cannot override this policy.

Commands are fixed by these contracts. Callers cannot supply shell fragments, install commands, test commands, or publish commands.

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

`workflow-templates/` contains thin build, test, and GitHub Packages publish callers. Replace publish template package policy before use. Validate changes with:

```sh
node --test tests/*.test.mjs
ruby -e 'require "yaml"; Dir[".github/workflows/*.yml", "workflow-templates/*.yml"].each { |file| YAML.load(File.read(file)) }'
git diff --check
```
