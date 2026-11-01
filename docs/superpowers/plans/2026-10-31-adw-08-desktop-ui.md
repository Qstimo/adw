# ADW 08 — Desktop UI Dispatcher Implementation Plan

> **For agentic workers:** REQUIRED: Use `@superpowers:subagent-driven-development` (if subagents available) or `@superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Electron + React desktop UI that drives the full cycle — select repo/branch, lock spec, watch DAG/live events, inspect context/verification/evidence, review diff, accept/reject patch — without becoming a source editor.

**Architecture:** `apps/desktop` (Electron main + React renderer) talks to headless `packages/core` over typed IPC (Zod from `@adw/contracts`). Core already runs without Electron; desktop is a client. Screens match TZ §10: Project, Task, Context Explorer, Verification, Review. Optional “Open in IDE” shells out to external editor. UI is a dispatcher: no Monaco/full file editor.

**Tech Stack:** Electron, React 19, TypeScript, Vite (electron-vite or similar), Zod IPC, Vitest + React Testing Library for renderer; Playwright electron optional later.

**Depends on:** chunks 05–07 (core orchestration, review, web verification evidence).

**Out of scope:** Parallel worker UI polish (chunk 09), Android panel (chunk 10), theming experiments beyond readable functional layout, fork VS Code.

---

## Execution status (2026-11-01)

Typed IPC contracts/handlers, immutable execution policy (DB v6), bounded JSONL Node child transport, Electron main/preload and five React screens are implemented. Desktop has 19 tests (DOM, host doubles, allowlist/evidence and real compiled core client). Full suite: 317 passed, 2 optional live probes skipped; typecheck and desktop build pass. Native Electron runtime is unavailable, so actual window/DoD remain pending. Real HTTP/browser gate 07 remains blocked by sandbox EPERM; 08 acceptance/DoD is not declared unblocked or complete. See [status report](../../implementation/08-status.md).

The core runs in a separate **system Node child** instead of loading native SQLite inside Electron. Build: `pnpm desktop:core:build`; health: `node packages/core/dist/desktop-core.mjs --data-dir /tmp/adw-desktop-data --health`. `task.subscribeEvents` uses durable cursor polling. Decisions are exposed separately and within the bounded Project Map. Native approvals are implemented by the host and tested with dialog doubles; a real OS confirmation has not yet been exercised.

## Files map

| Path | Responsibility |
|------|----------------|
| `apps/desktop/package.json` | Electron app |
| `apps/desktop/electron/main.ts` | Window + spawn/connect core |
| `apps/desktop/electron/preload.ts` | contextBridge IPC |
| `apps/desktop/src/main.tsx` | React entry |
| `apps/desktop/src/ipc/client.ts` | Typed IPC client |
| `apps/desktop/src/screens/ProjectScreen.tsx` | Repo path, branch, dirty, worktrees |
| `apps/desktop/src/screens/TaskScreen.tsx` | Spec, DAG, agents, live events, stop |
| `apps/desktop/src/screens/ContextExplorer.tsx` | Map, knowledge, stale, cache stats |
| `apps/desktop/src/screens/VerificationScreen.tsx` | Criteria matrix + evidence |
| `apps/desktop/src/screens/ReviewScreen.tsx` | Diff, media, remarks, approve/reject |
| `apps/desktop/src/components/AcceptanceEditor.tsx` | Pre-lock only |
| `apps/desktop/src/App.tsx` | Navigation shell |
| `packages/core/src/ipc/server.ts` | IPC handlers implementing methods |
| `packages/contracts/src/ipc.ts` | Ensure all UI methods covered |
| `apps/desktop/tests/*.test.tsx` | Screen unit tests |
| `packages/core/tests/ipc.handlers.test.ts` | Handler tests |

---

### Task 1: Electron shell + typed IPC skeleton

**Files:**
- Create: `apps/desktop/**` skeleton, `packages/core/src/ipc/server.ts`
- Test: `packages/core/tests/ipc.handlers.test.ts`

- [x] **Step 1: Define IPC methods** (Zod):

`project.open`, `project.getStatus`, `task.createDraft`, `task.confirmSpec`, `task.get`, `task.subscribeEvents`, `task.cancel`, `context.getProjectMap`, `context.getDecisions`, `verification.getMatrix`, `review.getVerdict`, `review.acceptPatch`, `review.rejectPatch`

- [x] **Step 2: In-process `project.getStatus` tests check dirty/worktrees against a real temporary Git repository**

- [x] **Step 3: Main process loads core; preload exposes `window.adw.invoke(method, params)`

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(desktop): Electron shell with typed Zod IPC to core"
```

---

### Task 2: Project screen

**Files:**
- Create: `ProjectScreen.tsx`
- Test: `tests/ProjectScreen.test.tsx`

- [x] **Step 1: UI shows repository path picker, base branch select, dirty state badge, list of worktrees, privacy mode indicator**

- [x] **Step 2: No file editor; path is read-only text + folder dialog

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(desktop): project screen for repo and branch status"
```

---

### Task 3: Task screen — spec lock + live execution

**Files:**
- Create: `TaskScreen.tsx`, `AcceptanceEditor.tsx`
- Test: `tests/TaskScreen.test.tsx`

- [x] **Step 1: Draft intent + acceptance list → Confirm locks fields (disabled inputs)

- [x] **Step 2: Show DAG nodes and agent assignment reasons (reasons via event log; no dedicated assignment DTO)

- [x] **Step 3: Live event log via subscription (mock stream in tests)

- [x] **Step 4: Budget usage/limits + Stop button calls `task.cancel`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(desktop): task screen with spec lock and live events"
```

---

### Task 4: Context Explorer

**Files:**
- Create: `ContextExplorer.tsx`
- Test: `tests/ContextExplorer.test.tsx`

- [x] **Step 1: Render project map summary, saved decisions with confidence + provenance, stale flags, cache hit rate placeholder from broker stats**

- [x] **Step 2: Clicking artifact shows summary + link to contentRef (read-only viewer, not editor)

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(desktop): context explorer with provenance and stale flags"
```

---

### Task 5: Verification matrix

**Files:**
- Create: `VerificationScreen.tsx`
- Test: `tests/VerificationScreen.test.tsx`

- [x] **Step 1: Matrix rows = acceptance/checks; columns = status, duration, evidence links, notVerified warnings**

- [x] **Step 2: Open screenshot/video via bounded CAS chunks and in-app blob media tag

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(desktop): verification matrix with evidence links"
```

---

### Task 6: Review screen — accept/reject

**Files:**
- Create: `ReviewScreen.tsx`
- Test: `tests/ReviewScreen.test.tsx`

- [x] **Step 1: Unified diff read-only; remarks list; blocking highlighted**

- [x] **Step 2: Approve calls `review.acceptPatch` (controlled git accept — never push)

- [x] **Step 3: Reject calls `review.rejectPatch`

- [ ] **Step 4: Optional button Open in IDE (`xdg-open` / `code` / `cursor` via config) — external only

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(desktop): review screen with accept/reject and IDE bridge button"
```

---

### Task 7: Navigation + DoD manual script

**Files:**
- Create: `App.tsx`, `docs/superpowers/plans/dod-manual-checklist.md` (short)

- [x] **Step 1: App nav between five screens; deep-link to task id

- [x] **Step 2: Write manual DoD checklist matching TZ §16 for human pilot on demo-repo

- [x] **Step 3: Core starts headless: `node packages/core/dist/desktop-core.mjs --data-dir <external-dir> --health` without Electron (compiled subprocess test)**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(desktop): wire screens and document DoD manual checklist"
```

---

## Acceptance (TZ roadmap stage 8 + DoD §16)

- User can go from ticket to accept/reject without using a terminal (given local CLIs already authenticated).
- No in-app source editor.
- Core remains headless-capable.
- DoD checklist executable on demo TypeScript repo.

## Chunk complete when

Desktop app launches, IPC integration tests pass, DoD checklist filed; **Wave A DoD gate ready for human sign-off** before chunks 09–10.
