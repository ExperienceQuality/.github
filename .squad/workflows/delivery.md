# Delivery Workflow

Default workflow for every XQ Squad task.

```text
INTAKE
  -> DISCOVERY
  -> PLANNING
  -> EXECUTION
  -> INTEGRATION
  -> VERIFICATION
  -> MEMORY_UPDATE
  -> DELIVERY
```

Workflow may terminate with `FAILED`, `CANCELLED`, or `BLOCKED`.

## Intake

- Identify requested outcome.
- Establish acceptance criteria.
- Ask for clarification only when missing information prevents safe or correct execution.

## Discovery

- Read `.squad/README.md` and `.squad/MEMORY.md`.
- Search relevant memory with `.squad/scripts/memory-search.mjs`.
- Use `analyst` profile or direct exploration to find affected files, conventions, and commands.

## Planning

- Define tasks, dependencies, ownership, acceptance criteria, and integration boundaries.
- Prefer simple plans.
- Avoid parallelizing tightly coupled tasks without clear integration strategy.

## Execution

- For separate concurrent sessions, follow `concurrent-delivery.md`: obtain
  setup approval, acquire a non-overlapping claim, and work only in the assigned
  worktree. Main checkout remains user-owned.
- Serial mode never bypasses existing claims. When installed, inspect the
  delivery-session helper before writes; overlapping or indeterminate ownership
  blocks. Missing helpers in an opted-in concurrent delivery also block.
- Delegate independent tasks to profiles when supported.
- Use worktrees or isolated branches only when authorized and conflict risk justifies it.
- Execute directly when delegation is unavailable.

## Integration

- Reconcile outputs.
- Inspect full diff.
- Resolve conflicts without overwriting unrelated user changes or other agent work.

## Verification

- Run relevant repository checks.
- Report passed, failed, skipped, unexecuted.
- Never claim observed status for unexecuted checks.

## Memory update

- In concurrent mode, write delivery-local memory only within claimed scope.
  Shared memory requires its own scope; never write a main-checkout summary.
- Run memory maintenance using `memory-maintainer` profile or directly.
- Report `UPDATED`, `UNCHANGED`, or `BLOCKED`.
- Do not claim current memory if persistence failed.

## Delivery

Report:

- What changed.
- Satisfied acceptance criteria.
- Checks run and their observed status.
- Review findings and unresolved risks.
- Memory-maintenance outcome.
- Remaining blockers.

Do not push, commit, or open a PR unless authorized. Before any authorized push or PR creation, fetch the configured remote and rebase the working branch onto the current remote target branch. Resolve conflicts and rerun verification; if the rebase cannot complete, report `BLOCKED` and do not push or open a PR.

Concurrent completion retains its claim. Release requires explicit user approval
and confirmation that the owner session and its commands stopped; it never
removes the branch, worktree, or dirty edits.
