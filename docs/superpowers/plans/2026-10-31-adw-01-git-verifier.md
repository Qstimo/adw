# ADW 01 — Git Worktrees + VerifierRunner Implementation Plan

> **For agentic workers:** REQUIRED: Use `@superpowers:subagent-driven-development` (if subagents available) or `@superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement safe Git worktree lifecycle and an LLM-free VerifierRunner that produces green/red CheckResults with evidence, without touching the user's main working tree.

**Architecture:** `packages/git` wraps system `git` (child_process) for base SHA pin, task worktree create/remove, drift detection, and controlled patch apply/reject. `packages/verifier` runs configured commands inside a worktree, records exit codes, duration, env fingerprint, and artifact paths into SQLite via core. Orchestration entry points live in `packages/core` as thin facades.

**Tech Stack:** system git, Node child_process, Zod contracts from `@adw/contracts`, Vitest + temp git repos.

**Depends on:** chunk 00 (contracts, DB, demo-repo, config).

**Execution status (2026-10-31):** implemented and tested on Linux. See [execution report](../../implementation/01-status.md). Git commits unavailable in the current read-only metadata mount.

**Out of scope:** CLI agents, context broker, Playwright, UI, parallel worker worktrees (chunk 09), auto-push to main.

---

## Files map

| Path | Responsibility |
|------|----------------|
| `packages/git/package.json`, `src/index.ts` | Package entry |
| `packages/git/src/worktree-manager.ts` | Create/list/remove worktrees |
| `packages/git/src/base-commit.ts` | Resolve + pin immutable base SHA |
| `packages/git/src/drift.ts` | Detect base branch moved / dirty main |
| `packages/git/src/accept-patch.ts` | Controlled apply / reject into integration |
| `packages/git/tests/worktree-manager.test.ts` | Isolation tests |
| `packages/git/tests/accept-patch.test.ts` | Accept/reject tests |
| `packages/verifier/package.json`, `src/index.ts` | Package entry |
| `packages/verifier/src/runner.ts` | Run check pipeline |
| `packages/verifier/src/fingerprint.ts` | Env fingerprint |
| `packages/verifier/src/evidence-store.ts` | Copy logs into content-addressed store |
| `packages/verifier/tests/runner.test.ts` | Green/red on fixture |
| `packages/core/src/services/git-verifier-facade.ts` | Wire git+verifier+db |

---

### Task 1: GitWorktreeManager — create isolated worktree

**Files:**
- Create: `packages/git/src/worktree-manager.ts`
- Test: `packages/git/tests/worktree-manager.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitWorktreeManager } from "../src/worktree-manager.js";

function initRepo(dir: string) {
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "adw@test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "ADW"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "hi\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
}

describe("GitWorktreeManager", () => {
  let root: string;
  let mgr: GitWorktreeManager;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "adw-git-"));
    initRepo(root);
    mgr = new GitWorktreeManager(root);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("creates worktree at base SHA without dirtying main tree", () => {
    const mainReadme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    const wt = mgr.createTaskWorktree({
      taskId: "task_1",
      baseBranch: "master", // or main — detect default
    });
    expect(fs.existsSync(wt.path)).toBe(true);
    expect(wt.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    fs.writeFileSync(path.join(wt.path, "README.md"), "changed in worktree\n");
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe(mainReadme);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @adw/git test
```

- [ ] **Step 3: Implement `createTaskWorktree`**

- Resolve default branch if needed.
- `git rev-parse <branch>` → immutable `baseCommit`.
- `git worktree add <dataDir>/worktrees/<taskId> <baseCommit>` (detached OK).
- Return `{ path, baseCommit, taskId }`.

- [ ] **Step 4: Pass + commit**

```bash
git commit -m "feat(git): create isolated task worktrees pinned to base SHA"
```

---

### Task 2: Drift and cleanliness guards

**Files:**
- Create: `packages/git/src/drift.ts`
- Test: `packages/git/tests/drift.test.ts`

- [ ] **Step 1: Failing tests**

- Dirty main working tree → `assertSafeToAccept` throws.
- Base branch tip ≠ recorded `baseCommit` → `detectBaseDrift` returns `{ drifted: true, old, new }`.

- [ ] **Step 2: Implement using `git status --porcelain` and `git rev-parse`

- [ ] **Step 3: Pass + commit**

```bash
git commit -m "feat(git): detect base drift and dirty working tree"
```

---

### Task 3: Controlled accept / reject patch

**Files:**
- Create: `packages/git/src/accept-patch.ts`
- Test: `packages/git/tests/accept-patch.test.ts`

- [ ] **Step 1: Failing test**

- Worktree has a commit ahead of base → `acceptPatch` applies via `git format-patch` / `cherry-pick` / `diff | apply` into a **new local branch** `adw/accept/<taskId>` (never push).
- `rejectPatch` removes worktree and records rejection; main branch unchanged.

- [ ] **Step 2: Implement; never `git push`; never update `main`/`master` without explicit branch name for acceptance artifact

- [ ] **Step 3: Pass + commit**

```bash
git commit -m "feat(git): controlled patch accept/reject without push"
```

---

### Task 4: VerifierRunner green path

**Files:**
- Create: `packages/verifier/src/runner.ts`, `fingerprint.ts`, `evidence-store.ts`
- Test: `packages/verifier/tests/runner.test.ts`

- [ ] **Step 1: Failing test against `fixtures/demo-repo` (copy or clone into temp)**

```ts
it("runs typecheck+unit and returns all exitCode 0", async () => {
  const results = await runner.run({
    worktreePath: demoPath,
    checks: [
      { name: "typecheck", command: "pnpm typecheck", blocking: true },
      { name: "unit", command: "pnpm test", blocking: true },
    ],
  });
  expect(results.every((r) => r.exitCode === 0)).toBe(true);
  expect(results[0].environmentFingerprint).toBeTruthy();
  expect(results[0].baseCommit).toBeTruthy(); // if passed in
});
```

- [ ] **Step 2: Implement**

- Spawn with `cwd=worktreePath`, capture stdout/stderr to evidence store.
- Persist `CheckResult` shape from contracts.
- `environmentFingerprint`: hash of node version + lockfile hash + OS.

- [ ] **Step 3: Pass + commit**

```bash
git commit -m "feat(verifier): run blocking checks and store evidence"
```

---

### Task 5: VerifierRunner red path + notVerified

- [ ] **Step 1: Failing test — force unit fail (`FAIL_UNIT=1` or broken assertion fixture copy) → blocking check `exitCode !== 0`; overall `ready_for_review === false`

- [ ] **Step 2: Optional check missing binary → `notVerified: true`, warning, does **not** alone set false-green for required suite

- [ ] **Step 3: Implement policy: any failed **blocking** check fails the run; optional unavailable → `notVerified`

- [ ] **Step 4: Pass + commit**

```bash
git commit -m "feat(verifier): distinguish blocking fail vs optional notVerified"
```

---

### Task 6: Facade + audit event

**Files:**
- Create: `packages/core/src/services/git-verifier-facade.ts`
- Test: `packages/core/tests/git-verifier-facade.test.ts`

- [ ] **Step 1: Integration test** — create worktree from fixture git clone, run verifier, assert main tree untouched, audit_events row written

- [ ] **Step 2: Implement + commit**

```bash
git commit -m "feat(core): wire git+verifier facade with audit log"
```

---

## Acceptance (TZ roadmap stage 1)

- CLI-free path: worktree → checks → diff metadata.
- Green and red outcomes deterministic on demo-repo.
- Main project folder not modified by agent/worktree edits.
- No push to remote; no LLM calls.

## Chunk complete when

`pnpm --filter @adw/git test` and `pnpm --filter @adw/verifier test` green; facade integration test green.
