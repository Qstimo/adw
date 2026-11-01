# ADW 09 — Parallel Worker Worktrees + Integration (Thin Plan)

> **For agentic workers:** REQUIRED: Use `@superpowers:subagent-driven-development` (if subagents available) or `@superpowers:executing-plans`. Expand this thin plan into bite-sized TDD tasks before coding if requirements shifted after DoD pilot.

**Goal:** Allow independent DAG nodes to run in parallel in separate worker worktrees, then merge into an integration worktree with conflict detection — without two writers sharing one tree.

**Architecture:** Extend `GitWorktreeManager` with `createWorkerWorktree` per node id; Supervisor scheduler executes ready independent nodes concurrently. Integration stage cherry-picks/merges worker results into `integration` worktree; text conflicts → `needs_human`. Semantic/API break risk remains; rely on verifier (chunk 07) after integration — never treat clean merge as sufficiency.

**Tech Stack:** existing git package, supervisor DAG scheduler, Vitest with multi-worktree fixtures.

**Depends on:** DoD wave complete (chunks 00–08), especially 01 + 05 + 07.

**Out of scope:** Distributed remote agents, auto-resolve semantic conflicts, auto-push.

---

## Files map (expected)

| Path | Responsibility |
|------|----------------|
| `packages/git/src/worker-worktrees.ts` | Per-node worktrees |
| `packages/git/src/integrate.ts` | Merge/cherry-pick into integration WT |
| `packages/supervisor/src/scheduler-parallel.ts` | Concurrent ready-set execution |
| `packages/git/tests/parallel-integrate.test.ts` | No cross-tree overwrite |
| `packages/supervisor/tests/parallel-schedule.test.ts` | Independent nodes parallel; dependent serial |
| `apps/desktop` TaskScreen | Show parallel node status (light UI tweak) |

---

## Task outline

- [ ] **Task 1:** Refuse two sessions with same `worktreePath`; API enforces unique path per running node.
- [ ] **Task 2:** Scheduler runs independent nodes in parallel (Promise pool with concurrency limit from config).
- [ ] **Task 3:** Dependent node waits for parents' successful verify (not merely agent completed).
- [ ] **Task 4:** Integration worktree applies worker patches in topo order; conflict → structured error + stop.
- [ ] **Task 5:** Post-integration full verifier pipeline (including API/Playwright if enabled).
- [ ] **Task 6:** Tests prove file change in worker A does not appear in worker B path.
- [ ] **Task 7:** Document merge-clean ≠ contract-safe; point to verification gate.
- [ ] **Task 8:** Commit series `feat(git|supervisor): parallel worktrees and integration stage`.

---

## Acceptance (TZ roadmap stage 9)

- Parallel tasks without file overwrite across workers.
- Conflicts surfaced; no silent clobber.
- Integration verified by independent checks before human accept.

## Expand before execution

After DoD metrics, rewrite Tasks 1–8 into full writing-plans TDD steps with exact commands if APIs drifted.
