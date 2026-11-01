# Memory Maintenance Workflow

Run after verification and before final delivery report.

## Concurrent delivery

When a delivery has an active claim, follow `concurrent-delivery.md` before any
memory write. Use the assigned worktree and the claimed
`.squad/memory/deliveries/<delivery-id>.ndjson` file. The current updater also
writes `.squad/memory/deliveries/.<delivery-id>.ndjson.tmp`; reserve that exact
temporary path and any candidate outputs before running it. Do not claim the
whole shared delivery directory or silently expand scope. Check ownership before
starting and verify outputs after.

The canonical steps below still govern review and record validation, but do not
authorize writing `.squad/MEMORY.md`, `lessons.ndjson`, `delivery-events.ndjson`,
or another delivery's memory. Those paths require their own scope reservation;
overlaps block without override. Never update memory in the main checkout.

Retrieve explicit sources; the search CLI does not recursively discover delivery
files. For example, from the delivery worktree:

```bash
node .squad/scripts/memory-search.mjs auth \
  --source lessons.ndjson \
  --source delivery-events.ndjson \
  --source deliveries/fix-login-redirect.ndjson
```

Use stable record IDs that remain distinct across deliveries and preserve the
existing schema. Pass the claimed delivery file as the updater's explicit target.
Keep candidates and temporary outputs in approved, isolated paths. Do not use
`--force` to bypass failed validation.

Report one maintenance outcome. `UPDATED` means validated local memory is
included in this delivery branch; separately state "canonical integration
pending" when shared knowledge has not been reconciled. Do not claim a canonical
update merely because the delivery-local file changed. `UNCHANGED` and `BLOCKED`
retain their normal meanings. Later canonical reconciliation is a separately
authorized integration in a delivery worktree with the required scope.

## Steps

1. Review delivery for reusable knowledge.
   - New conventions discovered.
   - Verified command patterns.
   - Architecture or design decisions.
   - Lessons that would help future sessions.

2. Inspect existing memory.
   - Read `.squad/MEMORY.md`.
   - Read `.squad/memory/lessons.ndjson` and `.squad/memory/delivery-events.ndjson`.
   - Use `.squad/scripts/memory-search.mjs` for targeted lookup.

3. Propose candidate records.
   - Avoid duplicates.
   - Mark superseded records.
   - Prevent secrets and conversation transcripts.

4. Validate proposed records.
   - Check NDJSON against `.squad/schemas/memory-record.schema.json`.
   - Confirm stable IDs.

5. Apply validated changes.
   - In concurrent mode, use the delivery-local target described above; shared
     canonical paths are not implied by this step.
   - Update `.squad/MEMORY.md` for canonical knowledge.
   - Use `.squad/scripts/memory-update.mjs` for NDJSON changes.

6. Report outcome.
   - `UPDATED` — changes applied.
   - `UNCHANGED` — reviewed, nothing durable justified.
   - `BLOCKED` — could not validate or persist; explain why.

## Rules

- One writer per NDJSON update.
- Validate before commit.
- Keep code and memory changes on the same branch.
