# ADW 02 — CLI Agent Adapters Implementation Plan

> **For agentic workers:** REQUIRED: Use `@superpowers:subagent-driven-development` (if subagents available) or `@superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define CapabilityManifest + AgentAdapter interfaces and ship Codex CLI and Claude Code adapters with versioned compatibility tests, session control, cancel, and structured event logging — without scraping ANSI or stealing subscription tokens.

**Architecture:** `packages/cli-adapters` exports `AgentAdapter` and two concrete adapters. Each adapter discovers binary + version, probes capabilities, spawns in a given worktree cwd, streams machine-readable output when available (JSON/JSONL), supports cancel/timeout/heartbeat, and maps provider errors to typed results. Compatibility matrix is data-driven (`compat/<agent>/<version>.json`). PTY only if a probe says non-interactive mode is unavailable (feature-flagged, not default protocol).

**Tech Stack:** Node `child_process` / optional `node-pty`, Zod event schemas from contracts, Vitest with mocked binaries fixtures.

**Depends on:** chunk 00 (contracts). Soft-depends on chunk 01 for real worktree cwd in integration tests (can mock cwd earlier).

**Execution status (2026-10-31):** implemented; fake-CLI acceptance checks and read-only installed-CLI probes passed on Linux. Real authenticated model sessions not run. See [execution report](../../implementation/02-status.md). Commits unavailable in current read-only Git metadata mount.

**Out of scope:** Supervisor routing, context bundles, Ollama agent loop, Cursor adapter (document stub only), Electron UI.

---

## Files map

| Path | Responsibility |
|------|----------------|
| `packages/cli-adapters/package.json`, `src/index.ts` | Exports |
| `packages/cli-adapters/src/types.ts` | AgentAdapter interface |
| `packages/cli-adapters/src/discover.ts` | which / version parse |
| `packages/cli-adapters/src/process-runner.ts` | spawn, cancel process tree, timeout |
| `packages/cli-adapters/src/codex/adapter.ts` | Codex CLI adapter |
| `packages/cli-adapters/src/codex/parse-events.ts` | JSONL/event parse |
| `packages/cli-adapters/src/claude-code/adapter.ts` | Claude Code adapter |
| `packages/cli-adapters/src/claude-code/parse-events.ts` | Event parse |
| `packages/cli-adapters/compat/codex/*.json` | Compatibility matrix rows |
| `packages/cli-adapters/compat/claude-code/*.json` | Compatibility matrix rows |
| `packages/cli-adapters/tests/fixtures/fake-codex.mjs` | Fake CLI for unit tests |
| `packages/cli-adapters/tests/fixtures/fake-claude.mjs` | Fake CLI |
| `packages/cli-adapters/tests/adapter.interface.test.ts` | Contract tests |
| `packages/cli-adapters/tests/codex.compat.test.ts` | Versioned tests |
| `packages/cli-adapters/tests/claude-code.compat.test.ts` | Versioned tests |
| `packages/cli-adapters/tests/cancel.test.ts` | Cancellation |

---

### Task 1: AgentAdapter interface + CapabilityManifest wiring

**Files:**
- Create: `packages/cli-adapters/src/types.ts`
- Test: `packages/cli-adapters/tests/adapter.interface.test.ts`
- Modify if needed: `packages/contracts/src/agent.ts`

- [ ] **Step 1: Lock interface in contracts (extend if gap from chunk 00)**

```ts
export interface AgentAdapter {
  readonly id: "codex" | "claude-code";
  discover(): Promise<{ binaryPath: string; version: string }>;
  probeCapabilities(version: string): Promise<CapabilityManifest>;
  startSession(input: {
    worktreePath: string;
    prompt: string;
    bundlePath?: string;
    timeoutMs: number;
    resumeSessionId?: string;
  }): AsyncIterable<AgentEvent>;
  cancel(sessionId: string): Promise<void>;
}
```

`AgentEvent` Zod union: `session_started` | `log` | `tool_call` | `tool_result` | `usage` | `completed` | `failed` | `heartbeat`.

- [ ] **Step 2: Failing test — fake adapter satisfies type and yields `completed`**

- [ ] **Step 3: Implement types + commit**

```bash
git commit -m "feat(cli-adapters): define AgentAdapter and AgentEvent contracts"
```

---

### Task 2: Process runner — spawn, heartbeat, cancel tree

**Files:**
- Create: `packages/cli-adapters/src/process-runner.ts`
- Test: `packages/cli-adapters/tests/cancel.test.ts`

- [ ] **Step 1: Failing test with long-running `node -e "setInterval(...)"` child**

- Start → receive heartbeats (or synthetic from runner).
- `cancel` kills child **and** descendants (process group / `tree-kill` equivalent).
- Timeout triggers `failed` with reason `timeout`.

- [ ] **Step 2: Implement with detached process group where OS allows; document Windows gap in comment + test skip

- [ ] **Step 3: Pass + commit**

```bash
git commit -m "feat(cli-adapters): process runner with timeout and cancel"
```

---

### Task 3: Fake CLIs + Codex adapter unit tests

**Files:**
- Create: `tests/fixtures/fake-codex.mjs`, `src/codex/*`
- Test: `tests/codex.compat.test.ts`

- [ ] **Step 1: Fake binary** prints JSONL events then exits 0; supports `--version`

- [ ] **Step 2: Failing test — adapter discovers fake via `ADW_CODEX_PATH`, parses events, returns completed

- [ ] **Step 3: Implement Codex adapter:

- Prefer documented non-interactive flags (verify against installed CLI docs at implement time; encode assumed flags in compat JSON).
- Do **not** parse ANSI as primary.
- Do **not** read auth token files to exfiltrate; rely on CLI's own login state.
- Working directory = worktree.

- [ ] **Step 4: Write `compat/codex/default.json`:**

```json
{
  "minVersion": "0.0.0",
  "execution": { "headless": "probe", "cwd": true },
  "session": { "resume": "unknown" },
  "output": { "jsonl": "probe" },
  "tools": { "mcp": "unknown" },
  "control": { "cancel": true, "timeout": true }
}
```

- [ ] **Step 5: Pass + commit**

```bash
git commit -m "feat(cli-adapters): Codex adapter with fake-CLI compatibility tests"
```

---

### Task 4: Claude Code adapter + compat tests

**Files:**
- Create: `src/claude-code/*`, `tests/fixtures/fake-claude.mjs`, `compat/claude-code/default.json`
- Test: `tests/claude-code.compat.test.ts`

- [ ] **Step 1–5: Mirror Task 3 for Claude Code** (separate flags/event shapes in parse layer)

```bash
git commit -m "feat(cli-adapters): Claude Code adapter with compatibility tests"
```

---

### Task 5: Live probe suite (skippable)

**Files:**
- Create: `tests/live.probe.test.ts`

- [ ] **Step 1: Tests gated by `ADW_LIVE_CLI=1`**

- If `codex` / `claude` binaries exist: `discover`, `probeCapabilities`, print matrix row.
- If missing: skip (not fail).

- [ ] **Step 2: Document in package README how to refresh compat JSON from probe output

- [ ] **Step 3: Commit**

```bash
git commit -m "test(cli-adapters): optional live CLI capability probes"
```

---

### Task 6: Stub notes for Ollama / Cursor

**Files:**
- Create: `packages/cli-adapters/docs/future-adapters.md`

- [ ] **Step 1: Document** Ollama = inference only (needs separate agent loop later); Cursor = experimental only via official CLI/extension — no promise until probed.

- [ ] **Step 2: Commit**

```bash
git commit -m "docs(cli-adapters): note Ollama and Cursor adapter boundaries"
```

---

## Acceptance (TZ roadmap stage 2)

- Session start, event stream, cancel, errors, version discovery covered by tests (fake binaries).
- Compatibility matrix files exist and are loaded by adapters.
- No ANSI-primary protocol; no subscription token extraction.
- Live probes optional and skippable in CI.

## Chunk complete when

Unit/compat tests green without real CLI; live probe documented; adapters exportable from `@adw/cli-adapters`.
