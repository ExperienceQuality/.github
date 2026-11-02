# ExperienceQuality organization automation

Reusable GitHub Actions workflows for Node.js build, test, and publish to GitHub Packages.

## Shared workflows

| Workflow | Purpose |
|----------|---------|
| `node-build.yml` | Install with frozen lockfile; run `ci:build` |
| `node-test.yml` | Install with frozen lockfile; run `ci:test` |
| `node-publish.yml` | Publish package in `working-directory` via `ci:publish` when version is new |

## Consumer contract

| Script | Where | Required by |
|--------|-------|-------------|
| `ci:build` | `package.json` in `working-directory` | node-build |
| `ci:test` | `package.json` in `working-directory` | node-test |
| `ci:publish` | package being published | node-publish |

`ci:publish` builds if needed, then publishes that one package. npm: `"npm publish"` or `"npm run build && npm publish"`. pnpm workspace: `"pnpm run build && pnpm publish --no-git-checks"`.

Root lockfile required (`package-lock.json` or `pnpm-lock.yaml`). pnpm needs root `packageManager: "pnpm@x.y.z"`. Install at root; scripts in `working-directory`.

| Input | Default |
|-------|---------|
| `node-version` | `"24"` |
| `package-manager` (`npm` \| `pnpm`) | required |
| `working-directory` | `"."` |

`node-publish` output: `published` = `"true"` / `"false"`.

Permissions: build/test `contents: read`. Publish `contents: read` + `packages: write`.

Registry `https://npm.pkg.github.com`, scope `@experiencequality`, auth `NODE_AUTH_TOKEN = github.token` only. No `NPM_TOKEN`, no `secrets: inherit`.

Publish skips `"private": true` or when `npm view <name>@<version>` finds the version; else runs `ci:publish`. Callers use `needs: [build, test]` and `push` to default branch only.

Release = PR that bumps `version` in `package.json`. Merge publishes; no bump publishes nothing.

### Monorepo

Call `node-publish` once per package (`strategy.matrix` over `working-directory`). pnpm workspaces must use `pnpm publish` so `workspace:*` rewrites.

### Caller example

```yaml
name: Release
on:
  push:
    branches: [$default-branch]
permissions:
  contents: read
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
jobs:
  build:
    uses: ExperienceQuality/.github/.github/workflows/node-build.yml@v2
    with:
      package-manager: npm
  test:
    uses: ExperienceQuality/.github/.github/workflows/node-test.yml@v2
    with:
      package-manager: npm
  publish:
    needs: [build, test]
    uses: ExperienceQuality/.github/.github/workflows/node-publish.yml@v2
    permissions:
      contents: read
      packages: write
    with:
      package-manager: npm
```

## GitHub Packages publishing

Use caller `GITHUB_TOKEN` only — no `NPM_TOKEN`, no `secrets: inherit`. Packages use owner scope (e.g. `@experiencequality/example`). First publish gets registry default visibility; maintainer must set visibility and repo access. This hub never changes package visibility.

## Breaking changes in v2.0.0

- Helper script removed.
- `ci:release` and `artifacts/*.tgz` contract removed.
- `package-name`, `package-directory`, `tag-prefix` inputs removed.
- Tag-gated publish replaced by default-branch push when version is new, via `ci:publish`.
- Actions bumped: checkout v7, setup-node v7, pnpm/action-setup v6.

## Release policy

- Immutable tags `vN.0.0` per release; move major `vN` only after maintainer-approved validation.
- `vN` / `vN.x.y` tags: maintainers only. Roll back by moving `vN` or pinning callers.
- Never create package tags as part of hub release validation.
- `v1` / `v1.1.x` frozen indefinitely: no fixes, never deleted.

## Validation

Run `actionlint` locally; validate a candidate via consumer branch pinned to candidate SHA.
