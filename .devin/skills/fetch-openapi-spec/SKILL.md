---
name: fetch-openapi-spec
description: Fetch the latest OpenAPI contract for a service from the centralized xq-luthor repository into this repo's openapi/ directory. Use when the user asks to download, sync, update, or pull an OpenAPI spec or API contract, or needs a service client regenerated from the latest contract.
triggers:
  - user
  - model
---

# fetch-openapi-spec

API contracts are centralized in the `xq-luthor` repository under
`openapi/<service>/openapi.yaml`. This repo consumes them; do not hand-edit
local copies — sync them from source.

## Process

1. **Pick the service.** If the user did not name one, list candidates:

   ```bash
   node .squad/scripts/fetch-openapi-spec.mjs --list
   ```

2. **Fetch the spec** into the repo-root `openapi/` directory:

   ```bash
   node .squad/scripts/fetch-openapi-spec.mjs <service>
   node .squad/scripts/fetch-openapi-spec.mjs --all      # every service
   ```

   Options: `--out <dir>` to change the target, `--ref <branch|tag|sha>` to pin
   a source revision (default: the xq-luthor default branch), `--repo` or
   `XQ_OPENAPI_REPO` to point at a fork or mirror.

   Auth uses the `gh` CLI when installed, else `GH_TOKEN`/`GITHUB_TOKEN`,
   else unauthenticated access for public repos. If the fetch fails with
   401/403, stop and ask the user for credentials — do not retry with
   guessed tokens.

3. **Report provenance.** The script prints the resolved source sha; include
   it in your reply so the user can trace which contract version landed.

4. **Follow through.** If the spec changed (`git diff openapi/`), surface the
   diff summary and ask before regenerating clients or changing code that
   consumes the contract — that is a separate delivery.
