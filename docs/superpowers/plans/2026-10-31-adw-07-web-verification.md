# ADW 07 — API Smoke + Playwright Web Verification Implementation Plan

> **For agentic workers:** REQUIRED: Use `@superpowers:subagent-driven-development` (if subagents available) or `@superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Verifier with API smoke/schema checks and Playwright browser E2E that produce screenshots/video/DOM/console/network evidence, linked to acceptance criteria — without treating media as automatic full-correctness proof.

**Architecture:** Add check kinds to `packages/verifier`: `api_smoke`, `playwright_e2e`. Demo fixture gains a minimal HTTP server + one HTML page. Playwright tests live in fixture or `packages/verifier/e2e`. Each run stores artifacts in CAS and CheckResult rows with `coverage` + `notVerified`. Map acceptance ids → e2e test titles via `acceptanceMap.json`.

**Tech Stack:** Playwright, Node http for demo API, Zod schema checks, Vitest for unit; Playwright test runner for e2e.

**Depends on:** chunk 01 (VerifierRunner), 00 (fixture). Integrates with supervisor after 05.

**Out of scope:** Android ADB (chunk 10), Desktop UI matrix screen (chunk 08 consumes evidence), visual LLM review.

---

## Execution status (2026-11-01)

Implementation prepared; **real acceptance gate pending**, not complete. See [report](../../implementation/07-status.md): sandbox denies local listen/Chromium setsockopt, actual web:pilot returns notVerified and nonzero exit. Unit/protocol coverage does not replace the real E2E. Uses cached Playwright Core + bounded worker because registry/global store are unavailable; real browser setup/run commands are documented. Chunk 08 is not declared unblocked. Git commits remain unavailable (.git empty/read-only).

## Files map

| Path | Responsibility |
|------|----------------|
| `fixtures/demo-repo/src/server.ts` | Tiny API + static page |
| `fixtures/demo-repo/acceptanceMap.json` | acceptanceId → test title |
| `fixtures/demo-repo/e2e/smoke.spec.ts` | Playwright smoke |
| `packages/verifier/src/checks/api-smoke.ts` | HTTP + optional JSON schema |
| `packages/verifier/src/checks/playwright.ts` | Spawn playwright test |
| `packages/verifier/src/acceptance-link.ts` | Link results to acceptance |
| `packages/verifier/tests/api-smoke.test.ts` | API tests |
| `packages/verifier/tests/playwright-check.test.ts` | E2E check wrapper |
| `packages/verifier/tests/acceptance-link.test.ts` | Mapping tests |

---

### Task 1: Expand demo-repo with server + page

**Files:**
- Create: `fixtures/demo-repo/src/server.ts`, `public/index.html`, script `start:demo`

- [ ] **Step 1: GET `/health` → `{ ok: true }`; GET `/` serves button `#go` that sets `#status` to `ready`

- [ ] **Step 2: Document port via `PORT` env (default 5179)

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(fixtures): demo HTTP server and page for web verification"
```

---

### Task 2: API smoke check

**Files:**
- Create: `packages/verifier/src/checks/api-smoke.ts`
- Test: `tests/api-smoke.test.ts`

- [ ] **Step 1: Failing test — start server, GET /health expect 200 and schema `{ ok: boolean }`**

- [ ] **Step 2: On failure record exitCode≠0, body snippet in evidence (redact auth headers)

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(verifier): API smoke and schema check"
```

---

### Task 3: Playwright check + evidence

**Files:**
- Create: `fixtures/demo-repo/e2e/smoke.spec.ts`, `packages/verifier/src/checks/playwright.ts`
- Test: `tests/playwright-check.test.ts`

- [ ] **Step 1: Spec** — open `/`, click `#go`, expect `#status` text `ready`; screenshot on success/fail; video retain on fail

- [ ] **Step 2: Wrapper runs `pnpm exec playwright test` in worktree; copies `test-results/**` into evidence store

- [ ] **Step 3: CheckResult includes artifactRefs for png/webm; `coverage` notes which acceptance ids ran

- [ ] **Step 4: Evidence disclaimer field `proves: "scenario_observation"` — not `full_correctness`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(verifier): Playwright e2e check with screenshot/video evidence"
```

---

### Task 4: Acceptance linkage + test-change highlighting hook

**Files:**
- Create: `acceptance-link.ts`, `acceptanceMap.json`
- Test: `acceptance-link.test.ts`

- [ ] **Step 1: Map acceptance criterion ids to e2e titles; missing map → warning `notVerified` for that criterion

- [ ] **Step 2: Utility `listChangedTestPaths(diff)` for review UI later

- [ ] **Step 3: Required acceptance fail → blocks ready_for_review; optional → notVerified warning

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(verifier): link e2e results to acceptance criteria"
```

---

### Task 5: Wire into VerifierRunner pipeline order

**Files:**
- Modify: `packages/verifier/src/runner.ts`
- Test: update runner tests

Pipeline order (TZ §8): environment health → build/typecheck/lint → unit → app/db up → **api smoke** → **playwright** → (android later) → review.

- [ ] **Step 1: Config section `verifier.web` enable flags

- [ ] **Step 2: Integration test runs typecheck+unit+api+playwright on demo (may be slower; mark as separate vitest project if needed)

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(verifier): insert API and Playwright into check pipeline"
```

---

## Acceptance (TZ roadmap stage 7)

- Real browser scenario verified end-to-end on demo-repo.
- Screenshots/video stored as evidence with explicit non-proof-of-total-correctness.
- Acceptance mapping drives blocking vs notVerified.

## Chunk complete when

API + Playwright checks green in CI (Playwright browsers installed in setup instructions); supervisor can consume new check kinds.
