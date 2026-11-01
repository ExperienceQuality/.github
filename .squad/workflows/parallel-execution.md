# Parallel Execution Workflow

Use only when tasks are independent and integration strategy is clear.

## Separate sessions

Separate agent sessions follow `concurrent-delivery.md`, not an informal
subagent plan. Each delivery requires user-approved setup, an isolated worktree,
and an atomic write-scope claim. Overlaps hard-block without override.
Subagents inherit their Lead's worktree, ownership context, and write scope.
Neither serial fallback nor unavailable subagents bypass existing claims.

## When to parallelize

- Independent exploration across unrelated modules.
- Independent test suites that do not share mutable state.
- Review of already completed, isolated changes.

## When not to parallelize

- Tightly coupled tasks.
- Tasks that edit the same files.
- Tasks without a defined integration owner.
- Background subagents when required permissions are not pre-approved.

## Procedure

1. Lead defines each task with:
   - clear acceptance criteria;
   - expected output format;
   - files or areas to touch;
   - constraints and dependencies.

2. Lead delegates to profiles in foreground or background.
   - Use foreground when writes or tests may need approval.
   - Use background only for read-only or pre-approved work.

3. Lead integrates results.
   - Reconcile conflicts explicitly.
   - Do not overwrite another agent's work or unrelated user changes.

4. Lead verifies integrated result.

## Fallback

If custom subagents are unavailable, execute tasks sequentially. Do not let parallelization become a hard requirement.

This fallback changes role execution only; it does not authorize writing in the
main checkout or releasing another session's claim.
