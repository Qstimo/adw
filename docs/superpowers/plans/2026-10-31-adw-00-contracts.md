# ADW 00 — Contracts + SQLite + Fixture Implementation Plan

> **For agentic workers:** REQUIRED: Use `@superpowers:subagent-driven-development` (if subagents available) or `@superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bootstrap the ADW monorepo with shared Zod contracts, SQLite schema/migrations, app config, and a TypeScript/Node/React demo fixture that later chunks can run against.

**Architecture:** pnpm workspace monorepo. `packages/contracts` owns all Zod schemas and inferred types (IPC + domain). `packages/core` owns SQLite (WAL) + migrations + a thin config loader. `fixtures/demo-repo` is a tiny green/red-capable app used by git/verifier/supervisor tests. No Electron yet; core must be headless-ready.

**Tech Stack:** Node.js 22+, TypeScript 5.x, pnpm workspaces, Zod, better-sqlite3 (or `libsql`), Vitest.

**Depends on:** nothing (first chunk).

**Execution status (2026-10-31):** acceptance gate passed: root install/typecheck/test and native SQLite tests pass; commits unavailable because workspace .git metadata is read-only and empty. See [execution report](../../implementation/00-status.md).

**Out of scope:** Git worktrees, CLI agents, indexer, UI, Playwright.

---

## Files map

| Path | Responsibility |
|------|----------------|
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` | Workspace root |
| `packages/contracts/package.json`, `src/index.ts` | Public contract exports |
| `packages/contracts/src/ids.ts` | Branded IDs |
| `packages/contracts/src/project.ts` | Project / repo config |
| `packages/contracts/src/task.ts` | Task, acceptance, DAG node stubs |
| `packages/contracts/src/context.ts` | ContextArtifact, ContextBundle, Finding |
| `packages/contracts/src/agent.ts` | CapabilityManifest, agent events |
| `packages/contracts/src/verification.ts` | CheckResult, EvidenceRef |
| `packages/contracts/src/git.ts` | Worktree, base commit, patch acceptance |
| `packages/contracts/src/ipc.ts` | Core↔UI request/response envelopes |
| `packages/core/package.json`, `src/index.ts` | Core package entry |
| `packages/core/src/db/schema.sql` | Canonical SQL |
| `packages/core/src/db/migrate.ts` | Migration runner |
| `packages/core/src/db/client.ts` | SQLite open (WAL) |
| `packages/core/src/config.ts` | Load/validate `adw.config.json` |
| `packages/core/tests/migrate.test.ts` | Migration tests |
| `packages/core/tests/config.test.ts` | Config tests |
| `packages/contracts/tests/*.test.ts` | Schema parse/reject tests |
| `fixtures/demo-repo/**` | Minimal TS app + scripts |
| `adw.config.example.json` | Example workstation config |
| `README.md` | How to install/test |

---

### Task 1: Scaffold monorepo

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`

- [ ] **Step 1: Create workspace root**

```json
// package.json
{
  "name": "adw",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "apps/*"
  - "fixtures/*"
```

- [ ] **Step 2: Add `.gitignore`** (`node_modules`, `dist`, `*.db`, `.adw/`, coverage)

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore
git commit -m "chore: scaffold ADW pnpm workspace"
```

---

### Task 2: Contracts package — IDs and domain schemas

**Files:**
- Create: `packages/contracts/**`
- Test: `packages/contracts/tests/context.test.ts`, `task.test.ts`, `verification.test.ts`

- [ ] **Step 1: Write failing test for ContextArtifact**

```ts
import { describe, it, expect } from "vitest";
import { ContextArtifactSchema } from "../src/context.js";

describe("ContextArtifactSchema", () => {
  it("accepts verified artifact with baseCommit and provenance fields", () => {
    const parsed = ContextArtifactSchema.parse({
      id: "art_01",
      projectId: "proj_01",
      kind: "decision",
      contentRef: "sha256:abc",
      baseCommit: "a".repeat(40),
      sourcePaths: ["src/a.ts"],
      sourceHashes: { "src/a.ts": "b".repeat(64) },
      producerAgent: "codex",
      confidence: "verified",
      createdAt: new Date().toISOString(),
      visibility: "project",
      tokenEstimate: 120,
    });
    expect(parsed.confidence).toBe("verified");
  });

  it("rejects missing baseCommit", () => {
    expect(() =>
      ContextArtifactSchema.parse({
        id: "art_01",
        projectId: "proj_01",
        kind: "decision",
        contentRef: "sha256:abc",
        sourcePaths: [],
        sourceHashes: {},
        producerAgent: "codex",
        confidence: "inferred",
        createdAt: new Date().toISOString(),
        visibility: "task",
        tokenEstimate: 1,
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (module missing)**

```bash
pnpm --filter @adw/contracts test
```

- [ ] **Step 3: Implement schemas**

Required shapes (align with TZ §4.2):

- `ContextArtifact`: id, projectId, taskId?, kind, contentRef, summaryRef?, baseCommit, sourcePaths[], sourceHashes{}, producerAgent, confidence (`verified`|`inferred`|`unverified`), createdAt, expiresAt?, invalidatedAt?, visibility, tokenEstimate
- `ContextBundle`: taskId, targetAgent, baseCommit, acceptance[], selectedArtifacts[], sourceRefs[], tokenBudget, generatedAt
- `Finding`: claim, evidenceRefs[], affectedPaths[], verificationStatus
- `TaskSpec`: id, projectId, intent, acceptance[], outOfScope[], baseBranch, baseCommit, status
- `CheckResult`: name, command, exitCode, durationMs, environmentFingerprint, artifactRefs[], coverage?, notVerified?, blocking
- `CapabilityManifest`: agentId, execution, session, output, tools, usage, control (booleans / enums per TZ §5)
- `IpcRequest` / `IpcResponse`: typed envelope with `method`, `id`, `params` / `result` | `error`

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add Zod domain and IPC schemas"
```

---

### Task 3: SQLite schema + migrations

**Files:**
- Create: `packages/core/src/db/schema.sql`, `migrate.ts`, `client.ts`
- Test: `packages/core/tests/migrate.test.ts`

- [ ] **Step 1: Write failing migration test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, migrate } from "../src/db/client.js";

describe("migrate", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "adw-db-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("creates core tables and enables WAL", () => {
    const db = openDb(path.join(dir, "adw.sqlite"));
    migrate(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "projects",
        "tasks",
        "context_artifacts",
        "findings",
        "agent_sessions",
        "check_results",
        "audit_events",
        "schema_migrations",
      ]),
    );
    const journal = db.pragma("journal_mode", { simple: true });
    expect(String(journal).toLowerCase()).toBe("wal");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Implement schema** (minimum columns)

```sql
-- projects: id, path, default_base_branch, created_at
-- tasks: id, project_id, intent, acceptance_json, out_of_scope_json, base_branch, base_commit, status, created_at, updated_at
-- context_artifacts: full ContextArtifact fields + content blob ref
-- findings: id, task_id, claim, evidence_refs_json, affected_paths_json, verification_status, created_at
-- agent_sessions: id, task_id, agent_id, worktree_path, status, started_at, ended_at
-- check_results: id, task_id, name, command, exit_code, duration_ms, env_fingerprint, artifacts_json, not_verified, blocking, created_at
-- audit_events: id, at, actor, action, payload_json
-- schema_migrations: version, applied_at
```

- [ ] **Step 4: Run — expect PASS; commit**

```bash
git add packages/core
git commit -m "feat(core): SQLite WAL schema and migrations"
```

---

### Task 4: Config loader

**Files:**
- Create: `packages/core/src/config.ts`, `adw.config.example.json`
- Test: `packages/core/tests/config.test.ts`

- [ ] **Step 1: Failing test — valid config parses; unknown keys strip or reject (choose strict Zod)**

```ts
import { loadConfig } from "../src/config.js";

it("loads example config", () => {
  const cfg = loadConfig("adw.config.example.json");
  expect(cfg.dataDir).toBeTruthy();
  expect(cfg.agents).toEqual(expect.arrayContaining(["codex", "claude-code"]));
});
```

- [ ] **Step 2: Implement `AdwConfigSchema` in contracts or core; wire `loadConfig`

Example config:

```json
{
  "dataDir": ".adw",
  "agents": ["codex", "claude-code"],
  "verifier": {
    "commands": {
      "typecheck": "pnpm typecheck",
      "lint": "pnpm lint",
      "unit": "pnpm test"
    }
  },
  "privacyMode": "cli-subscription"
}
```

- [ ] **Step 3: Pass + commit**

```bash
git commit -m "feat(core): validate adw.config via Zod"
```

---

### Task 5: Demo fixture repo

**Files:**
- Create: `fixtures/demo-repo/package.json`, `src/index.ts`, `src/add.ts`, `src/add.test.ts`, `tsconfig.json`

- [ ] **Step 1: Minimal app with `add(a,b)` and vitest unit test that passes**

- [ ] **Step 2: Scripts: `typecheck`, `lint` (eslint or `tsc --noEmit` only if lint deferred), `test`

- [ ] **Step 3: Document how verifier chunk will flip a known-red check (e.g. `FAIL_UNIT=1`)

- [ ] **Step 4: Commit**

```bash
git add fixtures/demo-repo
git commit -m "feat(fixtures): add demo TypeScript app for ADW pilots"
```

---

### Task 6: Root README + typecheck gate

- [ ] **Step 1: README** — install (`pnpm i`), test (`pnpm test`), point to INDEX
- [ ] **Step 2: Ensure `pnpm typecheck` and `pnpm test` pass at root
- [ ] **Step 3: Commit**

```bash
git commit -m "docs: add ADW root README and verify workspace scripts"
```

---

## Acceptance (TZ roadmap stage 0)

- Contracts validate (Vitest) for happy path and required-field rejection.
- Fresh SQLite DB migrates to expected tables with WAL.
- Example config loads.
- `fixtures/demo-repo` installs and unit tests pass.
- No Electron dependency in `packages/core`.

## Chunk complete when

All tasks committed; `pnpm test` green; ready for chunk 01 (git+verifier) and parallel 02/03.
