# ADW 03 — Project Indexer Implementation Plan

> **For agentic workers:** REQUIRED: Use `@superpowers:subagent-driven-development` (if subagents available) or `@superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build L1 Project Index — deterministic indexing of files, symbols, imports, manifests, test commands — with source hashes, SQLite FTS5 search, and incremental invalidation when files or base commit change.

**Architecture:** `packages/context` owns `ProjectIndexer`. On repo connect: walk tree (respect gitignore), hash file contents, extract symbols via Tree-sitter where grammars available (TS/TSX/JS first), store path→hash and FTS documents. Ripgrep used for ad-hoc content search when FTS is insufficient. Invalidation: recompute only dependent index rows when source hash changes; mark stale knowledge hooks for chunk 04.

**Tech Stack:** ripgrep binary, Tree-sitter + TS grammar, SQLite FTS5 (via core DB or dedicated index DB under `.adw/index.sqlite`), Vitest, fixture demo-repo.

**Depends on:** chunk 00. Benefits from chunk 01 baseCommit pin for index keys.

**Execution status (2026-10-31):** implemented and tested on Linux; AST backend is TypeScript 5.9.3 because Tree-sitter/grammars are absent from the offline cache. See [execution report](../../implementation/03-status.md). Dedicated index DB; core DB version remains 2. Git commits unavailable in the current metadata mount.

**Out of scope:** Semantic embeddings (post-MVP), ContextBundle builder (chunk 04), agent session memory sync (L4).

---

## Files map

| Path | Responsibility |
|------|----------------|
| `packages/context/package.json`, `src/index.ts` | Exports |
| `packages/context/src/indexer/project-indexer.ts` | Orchestrates index build |
| `packages/context/src/indexer/walk.ts` | File walk + gitignore |
| `packages/context/src/indexer/hash.ts` | Content hashes |
| `packages/context/src/indexer/symbols.ts` | Tree-sitter symbol extract |
| `packages/context/src/indexer/manifests.ts` | package.json / tsconfig / test cmds |
| `packages/context/src/indexer/fts.ts` | FTS5 write/query |
| `packages/context/src/search/ripgrep.ts` | Ripgrep wrapper |
| `packages/context/src/db/index-schema.sql` | Index tables |
| `packages/context/tests/indexer.test.ts` | Full index on fixture |
| `packages/context/tests/invalidation.test.ts` | Incremental update |
| `packages/context/tests/search.test.ts` | FTS + ripgrep |

---

### Task 1: Index schema + walk + hash

**Files:**
- Create: `index-schema.sql`, `walk.ts`, `hash.ts`, `project-indexer.ts` (skeleton)
- Test: `tests/indexer.test.ts`

- [ ] **Step 1: Failing test**

```ts
it("indexes demo-repo files with stable source hashes", async () => {
  const idx = await ProjectIndexer.build({
    projectId: "proj_demo",
    repoPath: demoRepoPath,
    baseCommit: "WORK_TREE", // or real SHA if git
  });
  const map = idx.getProjectMap();
  expect(map.files.some((f) => f.path.endsWith("src/add.ts"))).toBe(true);
  expect(map.files[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: Tables**

```sql
-- indexed_files(project_id, path, content_hash, size, language, base_commit, updated_at)
-- project_manifests(project_id, kind, path, json, base_commit)
-- schema note: FTS virtual table indexed_files_fts(path, content)
```

- [ ] **Step 3: Implement walk (skip `node_modules`, `.git`, `.adw`) + sha256 hashes**

- [ ] **Step 4: Pass + commit**

```bash
git commit -m "feat(context): project file walk and content hashing"
```

---

### Task 2: Manifests and test command discovery

**Files:**
- Create: `manifests.ts`
- Test: extend `indexer.test.ts`

- [ ] **Step 1: Failing test — reads package.json scripts `test`/`typecheck`/`lint` into project map `testCommands`

- [ ] **Step 2: Implement + commit**

```bash
git commit -m "feat(context): index package manifests and test commands"
```

---

### Task 3: Symbol extraction (TS/TSX)

**Files:**
- Create: `symbols.ts`
- Test: `tests/symbols.test.ts`

- [ ] **Step 1: Failing test — `add.ts` yields symbol `{ name: "add", kind: "function", path, startLine, endLine }`

- [ ] **Step 2: Implement with Tree-sitter; if grammar load fails in CI, skip with clear message OR vendor wasm grammar in package

- [ ] **Step 3: Store `symbols` table; expose `getProjectMap().symbols`

- [ ] **Step 4: Pass + commit**

```bash
git commit -m "feat(context): Tree-sitter symbol map for TypeScript"
```

---

### Task 4: FTS5 + ripgrep search API

**Files:**
- Create: `fts.ts`, `search/ripgrep.ts`
- Test: `tests/search.test.ts`

- [ ] **Step 1: Failing tests**

- `searchCode({ query: "function add", scope: "src" })` returns path hits from FTS.
- Ripgrep path returns content line matches with line numbers.

- [ ] **Step 2: Implement `context.search_code` surface as `ProjectIndexer.searchCode` (chunk 04 will expose MCP/API)

- [ ] **Step 3: Require `rg` on PATH; fail with actionable error if missing in runtime (test can skip if absent)

- [ ] **Step 4: Pass + commit**

```bash
git commit -m "feat(context): FTS5 and ripgrep code search"
```

---

### Task 5: Incremental invalidation

**Files:**
- Create: logic in `project-indexer.ts` `reindexChanged`
- Test: `tests/invalidation.test.ts`

- [ ] **Step 1: Failing test**

- Build index → modify one file hash → `reindexChanged` updates only that path → unchanged paths keep prior `updated_at`.
- Changing `baseCommit` marks all rows for project as needing refresh (or namespaces index by baseCommit).

- [ ] **Step 2: Prefer **index keyed by `(projectId, baseCommit)`** for snapshot immutability (TZ §4.1); cheap path: copy-on-write new snapshot id

- [ ] **Step 3: Emit list of `staleArtifactHints: sourcePaths[]` for broker (chunk 04)

- [ ] **Step 4: Pass + commit**

```bash
git commit -m "feat(context): incremental index invalidation by source hash"
```

---

### Task 6: Resource limits

- [ ] **Step 1: Config knobs** — `maxFiles`, `maxFileBytes`, `maxTotalBytes`; skip/truncate with warnings in project map

- [ ] **Step 2: Test oversized file skipped

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(context): index resource limits for large repos"
```

---

## Acceptance (TZ roadmap stage 3)

- Project map, FTS, source hashes work on demo-repo.
- Incremental invalidation proven by test.
- Deterministic indexing dominant (no embeddings required).

## Chunk complete when

`pnpm --filter @adw/context test` green; `getProjectMap` + `searchCode` usable by chunk 04.
