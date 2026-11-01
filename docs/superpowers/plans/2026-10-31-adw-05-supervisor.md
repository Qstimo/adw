# ADW 05 — Supervisor State Machine + E2E Pilot Implementation Plan

> **For agentic workers:** REQUIRED: Use `@superpowers:subagent-driven-development` (if subagents available) or `@superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Supervisor that locks user-approved spec/acceptance, builds a DAG of subtasks, routes to CLI agents via hard constraints then scored fit, runs limited fix cycles (≤3), and delivers one headless end-to-end pilot on the demo repo.

**Architecture:** `packages/supervisor` owns a deterministic state machine. LLM (via CLI adapter) may propose DAG/plan text, but **status transitions** (`tests_passed`, `ready_for_review`, etc.) are assigned only by Verifier/Review gates — never by the executor agent self-claiming success. Routing logs explanations. Parallelism only for independent nodes (single worktree per node in this chunk; multi-worker in 09).

**Tech Stack:** XState (or explicit enum reducer), `@adw/cli-adapters`, `@adw/git`, `@adw/verifier`, `@adw/context`, Vitest; pilot script in `packages/core/scripts/e2e-pilot.ts`.

**Depends on:** chunks 01, 02, 04 (and 00/03 transitively).

**Out of scope:** Desktop UI, Playwright E2E (chunk 07), cross-agent review (chunk 06 — pilot may stub review as manual), parallel worktrees.

---

## Execution status (2026-10-31)

Implemented; [report](../../implementation/05-status.md) records verification and boundaries. Core DB v4; `pnpm pilot` runs a deterministic fake executor with real Git/context/checks. Ready means manual review pending chunk 06. Bundle CAS stays outside Git, and the DAG uses one task worktree serially. Commits remain unavailable because `.git` is empty/read-only.

## Files map

| Path | Responsibility |
|------|----------------|
| `packages/supervisor/package.json`, `src/index.ts` | Exports |
| `packages/supervisor/src/states.ts` | State enum + transitions |
| `packages/supervisor/src/machine.ts` | State machine |
| `packages/supervisor/src/spec-lock.ts` | Immutable acceptance after confirm |
| `packages/supervisor/src/dag.ts` | DAG model + topo schedule |
| `packages/supervisor/src/router.ts` | Capability fit scoring |
| `packages/supervisor/src/retry.ts` | Fix cycles + failure fingerprint |
| `packages/supervisor/src/orchestrate.ts` | Wire adapters/git/verifier/context |
| `packages/supervisor/tests/machine.test.ts` | Transition tests |
| `packages/supervisor/tests/router.test.ts` | Constraint then score |
| `packages/supervisor/tests/retry.test.ts` | Max 3 + fingerprint |
| `packages/core/scripts/e2e-pilot.ts` | Headless pilot |
| `packages/core/tests/e2e-pilot.test.ts` | Pilot with fake adapter |

---

### Task 1: State machine transitions

**Files:**
- Create: `states.ts`, `machine.ts`
- Test: `tests/machine.test.ts`

- [ ] **Step 1: Define states**

`draft` → `spec_pending_approval` → `spec_locked` → `planning` → `scheduled` → `running` → `verifying` → `fix_needed` | `ready_for_human_review` | `failed` | `cancelled` → `accepted` | `rejected`

- [ ] **Step 2: Failing tests — illegal transitions throw; agent event `completed` does **not** auto-set `ready_for_human_review` without verifier success**

- [ ] **Step 3: Implement pure reducer `transition(state, event)`; LLM outputs are `events` like `plan_proposed`, never `mark_tests_passed`

- [ ] **Step 4: Pass + commit**

```bash
git commit -m "feat(supervisor): deterministic task state machine"
```

---

### Task 2: Spec lock

**Files:**
- Create: `spec-lock.ts`
- Test: `tests/spec-lock.test.ts`

- [ ] **Step 1: Failing test — after `confirmSpec`, mutating acceptance array throws; stored copy deep-frozen / DB row immutable fields**

- [ ] **Step 2: Implement + write audit_events `spec_locked`

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(supervisor): immutable spec lock after user confirm"
```

---

### Task 3: DAG model + serial scheduler

**Files:**
- Create: `dag.ts`
- Test: `tests/dag.test.ts`

- [ ] **Step 1: Nodes `{ id, dependsOn[], agentHint?, status }`; reject cycles

- [ ] **Step 2: Scheduler yields ready nodes; this chunk runs **one at a time** even if parallelizable (log `wouldParallelize`)

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(supervisor): DAG validation and serial scheduler"
```

---

### Task 4: Router — hard constraints then score

**Files:**
- Create: `router.ts`
- Test: `tests/router.test.ts`

- [ ] **Step 1: Failing test**

- Agent missing `execution.headless` capability → eliminated before score.
- Among remaining, score uses weights: capability fit, availability, cost estimate, locality, risk; returns `{ agentId, score, reasons[] }`.

- [ ] **Step 2: Implement; always log reasons to audit

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(supervisor): agent router with hard constraints and explainable score"
```

---

### Task 5: Retry + failure fingerprint

**Files:**
- Create: `retry.ts`
- Test: `tests/retry.test.ts`

- [ ] **Step 1: On verifier fail → structured feedback blob → re-run same agent up to **3** fix cycles

- [ ] **Step 2: Identical failure fingerprint twice → `needs_human` or strategy change event (switch agent if second adapter available)

- [ ] **Step 3: Budget/timeout → forced `cancelled`/`failed` (100% stop gate)

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(supervisor): fix cycles with failure fingerprints and budget stops"
```

---

### Task 6: Orchestrator wiring

**Files:**
- Create: `orchestrate.ts`
- Test: `tests/orchestrate.integration.test.ts` with **fake** AgentAdapter

- [ ] **Step 1: Flow**

1. Lock spec.
2. Build trivial 1-node DAG (or parse plan JSON from fake agent).
3. `buildBundle` from context.
4. Write bundle file into worktree (e.g. `.adw/bundle.json`).
5. Start adapter session with prompt = task intent + bundle path.
6. On adapter completed → run VerifierRunner (never trust agent).
7. Green → `ready_for_human_review`; red → retry path.

- [ ] **Step 2: Pass + commit**

```bash
git commit -m "feat(supervisor): orchestrate bundle, agent, and verifier loop"
```

---

### Task 7: Headless e2e pilot

**Files:**
- Create: `packages/core/scripts/e2e-pilot.ts`
- Test: `packages/core/tests/e2e-pilot.test.ts`

- [ ] **Step 1: Pilot uses fixtures/demo-repo + FakeAdapter that edits `src/add.ts` comments or adds a harmless export

- [ ] **Step 2: Script prints journal path + final state; exit 0 on `ready_for_human_review`

- [ ] **Step 3: Optional live mode `ADW_LIVE_CLI=1` documented but not required for CI

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(core): headless e2e pilot for supervisor loop"
```

---

## Acceptance (TZ roadmap stage 5 + TASK-10)

- Spec lock, DAG, routing, retry with deterministic transitions.
- One e2e pilot (fake adapter) green in CI.
- Agent cannot self-assign tests-passed.
- Budget/timeout always stop the run.

## Chunk complete when

Supervisor tests + e2e pilot green; ready for review engine (06) and web verification (07).
