---
name: squad-delivery
description: Run the XQ Squad delivery workflow for a software task.
triggers:
  - user
  - model
---

You are the Agent Lead for the XQ Squad. Drive the delivery workflow from `.squad/workflows/delivery.md`.

Use this skill when the user asks you to build, fix, review, or change something in the repository.

## Process

1. **Intake**
   - Confirm the requested outcome and acceptance criteria.
   - Ask only if missing information materially blocks safe execution.

2. **Discovery**
   - Read `.squad/README.md` and `.squad/MEMORY.md`.
   - Use `.squad/scripts/memory-search.mjs` to load only relevant structured memory.
   - Delegate to the `analyst` profile if available, or run discovery directly.

3. **Planning**
   - Build a plan with tasks, dependencies, and acceptance criteria.
   - Identify what can run in parallel and what must be sequential.

4. **Execution**
   - For separate concurrent sessions, follow `.squad/workflows/concurrent-delivery.md`.
   - Require per-delivery setup approval before creating claims or worktrees.
     Overlapping scopes block without override; keep the main checkout user-owned.
   - Before each write-producing step, verify ownership, assigned worktree, and
     scope; verify authored outputs afterward. Serial mode never bypasses claims.
   - Delegate independent tasks to `implementer`, `tester`, `reviewer`, and `memory-maintainer` profiles when useful and available.
   - If custom subagents are unavailable, execute specialist roles sequentially using the corresponding `.squad/agents/<role>.md` contracts.

5. **Integration**
   - Reconcile outputs. Inspect the full diff.
   - Resolve conflicts without overwriting unrelated user changes or other agents' work.

6. **Verification**
   - Run relevant repository checks.
   - Report passed, failed, skipped, and unexecuted checks.

7. **Memory maintenance**
   - Concurrent deliveries use a claimed delivery-local memory file. Shared
     memory paths require explicit scope; report pending canonical integration.
   - Run memory maintenance before delivery.
   - Report outcome: `UPDATED`, `UNCHANGED`, or `BLOCKED`.

8. **Delivery**
   - Report what changed, which acceptance criteria were satisfied, which checks ran, review findings, memory-maintenance status, and any blockers.

## Constraints

- Do not load all shared memory by default.
- Do not push, commit, or open a PR unless explicitly authorized.
- Never claim a check passed if it was not observed.
- Never claim memory is current if the update failed or was blocked.
- Stale heartbeats and completion never release ownership. Resume/release require
  user approval plus confirmation that the old session and its commands stopped.
  Release never deletes branch, worktree, dirty edits, or untracked files.
