# ADW 04 — Context Artifact Store + Broker Implementation Plan

> **For agentic workers:** REQUIRED: Use `@superpowers:subagent-driven-development` (if subagents available) or `@superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement append-only ContextArtifact storage with provenance/confidence, invalidation, and a Context Broker that builds token-budgeted ContextBundles (lossless-first compression, hierarchical summaries, no silent overwrite of verified facts).

**Architecture:** Extend `packages/context` with `ArtifactStore` (SQLite metadata + content-addressed files under `.adw/artifacts/`) and `ContextBroker`. Broker ranks candidates from indexer + artifacts by relevance, reliability (confidence), freshness (source hashes vs index), and token cost; outputs immutable `ContextBundle` JSON for a task/agent. Findings publish into task namespaces; promote to L2 only when `confidence=verified` and provenance OK.

**Tech Stack:** `@adw/contracts`, SQLite, fs content-addressed store, Vitest; optional tiny tokenizer estimate (chars/4 or `gpt-tokenizer`).

**Depends on:** chunk 00, 03 (indexer). Uses baseCommit from chunk 01 conceptually.

**Out of scope:** Supervisor DAG, MCP server packaging (expose in-process API now; MCP bridge later), embeddings.

---

## Execution status (2026-10-31)

Implemented; see [report](../../implementation/04-status.md) for verification, API boundaries and deviations. CAS lives outside the repository. Source staleness is snapshot-relative; explicit invalidation persists. Commits are unavailable because `.git` is empty and read-only.

## Files map

| Path | Responsibility |
|------|----------------|
| `packages/context/src/artifacts/store.ts` | CRUD + CAS blobs |
| `packages/context/src/artifacts/invalidation.ts` | Mark stale by source hash |
| `packages/context/src/artifacts/promote.ts` | Task → project knowledge rules |
| `packages/context/src/broker/rank.ts` | Scoring |
| `packages/context/src/broker/compress.ts` | Lossless + summary hooks |
| `packages/context/src/broker/build-bundle.ts` | ContextBundle builder |
| `packages/context/src/api.ts` | TZ §4.6 method surface |
| `packages/context/tests/artifact-store.test.ts` | Provenance tests |
| `packages/context/tests/invalidation-artifacts.test.ts` | Stale marking |
| `packages/context/tests/build-bundle.test.ts` | Budget + acceptance intact |
| `packages/core/src/services/context-facade.ts` | Wire API to DB paths |

---

### Task 1: Content-addressed ArtifactStore

**Files:**
- Create: `artifacts/store.ts`
- Test: `tests/artifact-store.test.ts`

- [ ] **Step 1: Failing test**

```ts
it("stores artifact with baseCommit, sourceHashes, confidence", async () => {
  const art = await store.publish({
    projectId: "p1",
    taskId: "t1",
    kind: "finding",
    content: "Router uses worktree X",
    baseCommit: "a".repeat(40),
    sourcePaths: ["src/app.ts"],
    sourceHashes: { "src/app.ts": hash },
    producerAgent: "codex",
    confidence: "inferred",
    visibility: "task",
  });
  expect(art.contentRef).toMatch(/^sha256:/);
  const loaded = await store.getArtifact(art.id);
  expect(loaded?.summaryRef ?? loaded?.contentRef).toBeTruthy();
});
```

- [ ] **Step 2: Implement CAS write + SQLite row (contracts ContextArtifact)**

- [ ] **Step 3: Reject publish without `baseCommit` or with empty producerAgent

- [ ] **Step 4: Pass + commit**

```bash
git commit -m "feat(context): content-addressed artifact store with provenance"
```

---

### Task 2: Append-only + no silent verified overwrite

- [ ] **Step 1: Failing test — publishing new decision with same kind/path creates new artifact id; old remains; `get_decisions` returns latest non-invalidated but history query returns both

- [ ] **Step 2: Implement append-only policy; `invalidate(id, reason)` sets `invalidatedAt`

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(context): append-only artifacts with explicit invalidation"
```

---

### Task 3: Hash-based staleness

**Files:**
- Create: `artifacts/invalidation.ts`
- Test: `tests/invalidation-artifacts.test.ts`

- [ ] **Step 1: Failing test — index reports new hash for `src/app.ts` → artifacts listing that path become `stale` (invalidated or flagged) via `revalidateAgainstIndex`

- [ ] **Step 2: Implement; do not delete history

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(context): invalidate artifacts when source hashes drift"
```

---

### Task 4: Ranking + token budget bundle

**Files:**
- Create: `broker/rank.ts`, `broker/build-bundle.ts`, `broker/compress.ts`
- Test: `tests/build-bundle.test.ts`

- [ ] **Step 1: Failing tests**

- Bundle includes **full** acceptance criteria text even under tiny `tokenBudget` (acceptance never semantically compressed away).
- When budget tight, drops lowest-score inferred snippets before verified decisions.
- `selectedArtifacts` ids stable; `sourceRefs` point to CAS or repo paths.
- Cache key helper: `repoId + baseSha + pathHashes + query + summarizerVersion`.

- [ ] **Step 2: Lossless-first compress** — dedupe paths, patch-only excerpts (line ranges from indexer/search), hash refs; semantic summary only for `kind=research` with `summaryRef` + original `contentRef`

- [ ] **Step 3: Implement `buildBundle({ taskId, agentId, tokenBudget, acceptance, baseCommit })`

- [ ] **Step 4: Pass + commit**

```bash
git commit -m "feat(context): ContextBundle builder with token budget and ranking"
```

---

### Task 5: Findings API + promote rules

**Files:**
- Create: `artifacts/promote.ts`, methods on `api.ts`
- Test: `tests/findings.test.ts`

- [ ] **Step 1: `publish_finding` writes Finding + artifact in task namespace

- [ ] **Step 2: Promote to `visibility=project` only if `confidence=verified` AND evidenceRefs non-empty AND sources fresh

- [ ] **Step 3: Unverified claims stay task-scoped; never enter L2 Shared Knowledge

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(context): findings publish and verified-only promotion"
```

---

### Task 6: TZ §4.6 in-process API surface

**Files:**
- Create: `packages/context/src/api.ts`
- Test: `tests/api.test.ts`

Expose functions (names match TZ):

- `getProjectMap`
- `searchCode`
- `getArtifact`
- `getDecisions`
- `getTaskFindings`
- `publishFinding`
- `getTestHistory` (stub reading check_results if present; else empty)
- `buildBundle`

- [ ] **Step 1: Failing smoke test calling each method**

- [ ] **Step 2: Implement facade

- [ ] **Step 3: Document read vs write split for future MCP auth

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(context): expose Context Engine API surface"
```

---

## Acceptance (TZ roadmap stage 4)

- Repeated agents can receive relevant bundles (tested with two bundle builds sharing index).
- Provenance + base SHA on 100% artifacts in tests.
- Acceptance criteria not dropped under budget pressure.
- Stale artifacts flagged after file change.

## Chunk complete when

Broker + store tests green; supervisor (chunk 05) can call `buildBundle` and `publishFinding`.
