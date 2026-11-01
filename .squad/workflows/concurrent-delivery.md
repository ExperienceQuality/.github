# Concurrent Delivery Workflow

Opt-in coordination for separate agent sessions (Devin, Cursor, or mixed) in one local Git repository.
Each session remains its own Lead. There is no shared Lead or background coordinator.
This workflow requires Node.js >=20 and compatible installed delivery helpers.
Scripted tests do not establish compatibility with two actual runtime sessions.

## Safety contract

- Every concurrent delivery uses its own branch and worktree. The main checkout
  remains user-owned; never switch its branch, move its dirty edits, or use it as
  a fallback workspace.
- Overlapping write scopes hard-block. There is no override, including an
  additional user approval. A blocked delivery waits or proposes a genuinely
  disjoint scope before acquisition.
- Claims coordinate cooperating sessions, not manual edits or unrelated tools.
  Worktrees do not isolate ports, databases, services, or commands outside them.
- Heartbeats never expire claims. Completion, cancellation, a crash, or a stale
  timestamp never releases ownership automatically.

## 1. Inspect without writing

Read relevant repository instructions and memory. Inspect the explicit local
base ref, main checkout, installed helpers, and active delivery claims.

Use `node .squad/scripts/delivery-session.mjs status` with a JSON request on
stdin containing `repositoryPath`. An empty request uses the current repository.
Commands return one JSON result: `OK` exits 0, `BLOCKED` exits 2, `ERROR` exits 1.
Treat locked, incomplete, corrupt, or unknown-version state as indeterminate,
not an empty registry. Do not continue on missing or incompatible helpers.

Initial activation requires a quiescent main checkout. If an existing squad
session or unexplained writes may still be active, ask the user to establish
that baseline. Do not discard existing dirty files.

Opting out of this workflow does not permit bypassing another delivery's live
claim. Before serial delivery writes, inspect claims when the helper is present;
block overlapping or indeterminate work. If a separate delivery is active, use
an approved isolated concurrent delivery or wait, not a new writer in the main
checkout. Never infer permission from silence.

## 2. Propose and obtain approval

Show the user:

- Delivery ID, explicit base ref and resolved commit.
- Main checkout, proposed branch `squad/<delivery-id>`, and proposed worktree
  `.squad/worktrees/<delivery-id>` below that checkout.
- Exact write scope, including memory and known build/test outputs.
- Existing conflicts, shared-resource risks, and the local exclude entry needed
  to keep worktrees out of the main checkout's status.

Scopes contain literal repository-relative files or subtrees ending in `/`;
`.` reserves the repository. No globs. Reserve both sides of a rename. Broad
scopes reduce concurrency; reads do not need a claim. Internal Git/runtime
paths and paths escaping the delivery worktree are never delivery write scope.
For the current memory updater, include the exact sibling
`.squad/memory/deliveries/.<delivery-id>.ndjson.tmp` path as well as the memory
file. Candidate outputs also need approved paths; do not reserve the entire
shared delivery-memory directory.

Ask for explicit setup approval for this delivery. Record a reference to the
actual user message. An evidence object `{ "confirmed": true, "reference": "..." }`
records that approval; constructing the object is not itself user consent.
Without approval, do not create a registry, claim, branch, worktree, or exclude
entry. Approval for one delivery does not approve another.

## 3. Acquire and provision

Invoke `acquire` with `repositoryPath`, `deliveryId`, `mainCheckoutPath`,
`baseRef`, `scope`, and `approval`. Helpers resolve the common Git directory so
all linked worktrees coordinate through one registry.

Reservation is atomic with conflict checking. `PREPARING` already blocks
overlaps; `ACTIVE` means provisioning completed. A conflict creates no delivery
branch or worktree. An existing ID/path/branch is not permission to reuse it.

If provisioning fails, preserve partial artifacts and the blocking reservation.
Report `RECOVERY_REQUIRED`. Never delete artifacts, free the claim, retry with
an unowned checkout, or reinterpret failure as successful acquisition.
An acquire result with `recoveryRequired: true` already has a reservation;
inspect it and obtain stopped-session confirmation for recovery instead of
blindly retrying acquisition. Pre-reservation mutex contention can be retried
as an explicit new operation, never by stealing the lock.

Keep the returned owner token and generation in this session's local context.
Do not put tokens in shared memory or normal status reports. Tokens prevent
accidental ownership reuse; they are not an authentication security boundary.

## 4. Execute inside the assigned worktree

Set an explicit worktree working directory for every tool and child process.
Give delegated agents the same ownership context and write boundaries.

Before each write-producing step:

1. Confirm the claim is ACTIVE, token/generation still match, and the current
   worktree belongs to this delivery.
2. Validate all planned outputs, including generated files and memory paths,
   against scope and symlink containment.
3. Capture a delivery snapshot and retain it as data, not executable code.

After the step, verify delivery-authored tracked, deleted, renamed, untracked,
and detectable ignored output changes against that snapshot and claim.
An out-of-scope write is BLOCKED: report and preserve it, never silently revert
it or approve it retroactively. These checks cannot detect every possible
ignored-file overwrite or prevent an already-running external command.

The verifier's exported functions can be invoked through this local ESM wrapper.
Supply JSON on stdin with `action`, `context`, and, for verification, `baseline`.
Run only after compatible helpers are installed, from the assigned worktree:

```bash
node --input-type=module -e '
import { captureDeliverySnapshot, verifyDeliveryWrites } from "./.squad/scripts/delivery-verify.mjs";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (!["capture", "verify"].includes(request.action)) throw new Error("Invalid action");
const result = request.action === "capture"
  ? await captureDeliverySnapshot(request.context)
  : await verifyDeliveryWrites(request.context, request.baseline);
console.log(JSON.stringify(result));
process.exitCode = result.status === "OK" ? 0 : result.status === "BLOCKED" ? 2 : 1;
'
```

`context` contains `repositoryPath`, `deliveryId`, `ownerToken`, `generation`,
and `worktreePath`. Preserve the returned snapshot in an explicitly approved
local artifact; do not overwrite user files or write arbitrary Git metadata.

Use `heartbeat` with delivery ID, token, and generation under the original
setup grant. New outputs require `extend` with fresh scope approval and the
current ownership context before edits. Overlap still blocks. Do not shrink
scope while this session or its commands may still write.

Build/test steps must use disjoint local outputs. If a shared service or port
requires isolation not already authorized and established, block that step.
Do not provision external resources or start network operations implicitly.

## 5. Memory and integration

Reserve `.squad/memory/deliveries/<delivery-id>.ndjson` in the approved scope.
Use existing schema validation and an explicit output path. Retrieve relevant
shared memory and this delivery's file explicitly; do not assume recursive
search. Shared `.squad/MEMORY.md` or other memory files require their own
reserved scope. Report local `UPDATED` with canonical integration pending.

Review and integrate in the delivery worktree, never the main checkout.
Commit, fetch/rebase, push, and PR actions require applicable explicit user
authorization. Before an authorized push/PR, refresh the remote target and
rebase as required by the delivery contract; then review and verify again.
Do not use incoming target changes as permission for out-of-scope authored
conflict resolutions. Expand scope first or block. Ownership or base changes
invalidate snapshots; recapture only after authorized integration review,
never to conceal an existing scope violation.

## 6. Stop, resume, or release

Completion does not release the claim. To release or transfer ownership, ask
the user to explicitly confirm that the previous owner session AND all its
write-producing/background commands have stopped, and approve the operation.
Do not claim to have stopped a separate agent session unless observed.

`resume` and `release` take delivery ID, `expectedGeneration`, approval, and
stopped confirmation; a lost old token is not required. A concurrent ownership
change blocks stale recovery. Resume keeps the branch/worktree and rotates
ownership. Release records a tombstone and leaves branch, worktree, dirty
edits, and untracked files untouched. A released ID is not reused.

A stale heartbeat alone is never sufficient confirmation. No timeout takeover.
Cleanup is a separate user-authorized operation, not part of release.

### Manual mutex recovery

A crashed registry mutex blocks operations, including normal release. Report
its exact common-Git-directory path and inspect ownership evidence without
editing it. Ask the user to confirm that the mutex-holding operation and every
command it started have stopped. Ambiguous ownership remains BLOCKED.

After explicit approval of the specific recovery action, recheck repository
identity and the mutex's ownership evidence. Remove only that inspected mutex
and its owned marker, never the registry, claims, worktrees, or dirty files.
Do not use age, PID guesses, broad recursive deletion, or automatic recovery.
Re-read and validate the registry afterward; remaining inconsistencies block
until separately inspected and authorized recovery.
