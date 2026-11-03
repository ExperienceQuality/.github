# ExperienceQuality organization automation

Reusable GitHub Actions workflows for Node.js and Python build, test, and publish.

## Shared workflows

| Workflow | Purpose |
|----------|---------|
| `node-build.yml` | Install with frozen lockfile; run `ci:build` |
| `node-test.yml` | Install with frozen lockfile; run `ci:test` |
| `node-publish.yml` | Publish package in `working-directory` via `ci:publish` when version is new |
| `python-build.yml` | `uv sync --frozen`; run `ci-build` |
| `python-test.yml` | `uv sync --frozen`; run `ci-test` |
| `python-publish.yml` | Run `ci-publish` (writes `dist/`), create GitHub Release when version is new |

## Node.js consumer contract

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

### Node monorepo

Call `node-publish` once per package (`strategy.matrix` over `working-directory`). pnpm workspaces must use `pnpm publish` so `workspace:*` rewrites.

### Node caller example

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

## Python consumer contract

Tooling is **uv** only. Root `uv.lock` required. `uv sync --frozen` always runs at the repository root; scripts run in `working-directory`.

| Script | Where | Required by |
|--------|-------|-------------|
| `ci-build` | `[project.scripts]` (run via `uv run --frozen`) | python-build |
| `ci-test` | `[project.scripts]` (run via `uv run --frozen`) | python-test |
| `ci-publish` | `[project.scripts]` (run via `uv run --frozen`) | python-publish |

`ci-publish` must write release assets under `dist/` in `working-directory` (for example `uv build`). The hub then creates a GitHub Release and uploads those files. GitHub Packages has no Python registry — do not publish wheels there.

| Input | Default |
|-------|---------|
| `python-version` | `"3.12"` |
| `working-directory` | `"."` |
| `tag-prefix` (publish only) | `""` (release tag `vVERSION`) |

`python-publish` output: `published` = `"true"` / `"false"`.

Permissions: build/test `contents: read`. Publish `contents: write` (create release + upload assets). Auth `GH_TOKEN = github.token` only. No extra secrets, no `secrets: inherit`.

Publish skips when `pyproject.toml` has classifier `Private :: Do Not Upload`, or when `gh release view` finds tag `{tag-prefix}v{version}`; else runs `ci-publish` and `gh release create`. Callers use `needs: [build, test]` and `push` to default branch only.

Release = PR that bumps static `project.version` in `pyproject.toml` (dynamic versions unsupported). Merge publishes; unchanged version (existing tag) publishes nothing.

### Python monorepo

Call `python-publish` once per package (`strategy.matrix` over `working-directory`). Use a distinct `tag-prefix` when packages can share the same SemVer (release tags are repository-global).

### Python caller example

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
    uses: ExperienceQuality/.github/.github/workflows/python-build.yml@v2
  test:
    uses: ExperienceQuality/.github/.github/workflows/python-test.yml@v2
  publish:
    needs: [build, test]
    uses: ExperienceQuality/.github/.github/workflows/python-publish.yml@v2
    permissions:
      contents: write
```

## GitHub Packages publishing (Node.js)

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
