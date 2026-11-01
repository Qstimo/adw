# ADW 10 — Optional Android ADB + IDE Bridge (Thin Plan)

> **For agentic workers:** REQUIRED: Use `@superpowers:subagent-driven-development` (if subagents available) or `@superpowers:executing-plans`. Expand into full TDD tasks only when enabling these optional modules post-DoD.

**Goal:** Add optional Android instrumentation/UI hierarchy checks via ADB/SDK and a thin IDE bridge that opens paths/diffs in VS Code or Cursor — without making core depend on any IDE.

**Architecture:** Feature-flagged verifier check `android_adb` in `packages/verifier`. Separate tiny `packages/ide-bridge` (or `packages/core/src/ide-bridge.ts`) invokes official CLI/`code`/`cursor` URLs. Desktop “Open in IDE” from chunk 08 calls this bridge. Android evidence = logcat slice + UI dump XML; same evidence-not-full-proof rule as Playwright.

**Tech Stack:** ADB, optional Android SDK, existing verifier evidence store; OS-specific path handling.

**Depends on:** chunk 08 DoD; Android hardware/emulator available for live tests.

**Out of scope:** Full Android Studio embed, non-official Cursor control APIs, guaranteeing headless Android on all CI agents.

---

## Files map (expected)

| Path | Responsibility |
|------|----------------|
| `packages/verifier/src/checks/android-adb.ts` | ADB instrumentation / UI dump |
| `packages/verifier/tests/android-adb.test.ts` | Skip if no device; fake ADB fixture otherwise |
| `packages/ide-bridge/src/open.ts` | Open file/diff/repo in external IDE |
| `packages/ide-bridge/tests/open.test.ts` | Command building tests (no real IDE required) |
| `apps/desktop` | Wire Open in IDE + optional Android evidence pane |
| `docs/android-setup.md` | Provisioning notes Linux/macOS/Windows |

---

## Task outline

- [ ] **Task 1:** Config `verifier.android.enabled` default false; missing ADB → `notVerified` when optional, fail only if marked required.
- [ ] **Task 2:** Fake ADB script for unit tests returning fixed UI hierarchy XML + exit codes.
- [ ] **Task 3:** Live test gated by `ADW_ANDROID_DEVICE=1`.
- [ ] **Task 4:** Store UI dump + logcat excerpt as evidence artifacts with provenance fields.
- [ ] **Task 5:** IDE bridge: resolve binary from config (`ide.command`), open repo path and optional file:line; never import IDE extension host APIs into core.
- [ ] **Task 6:** Desktop button uses bridge; document unsupported deep automation for Cursor until official CLI probed (chunk 02 stance).
- [ ] **Task 7:** Cross-OS notes for sandbox/PTY/Android provisioning differences.
- [ ] **Task 8:** Commit series `feat(verifier|ide-bridge): optional Android checks and IDE open`.

---

## Acceptance (TZ roadmap stage 10)

- ADB check runs behind flag with separate tests.
- IDE bridge opens external editor; core remains IDE-agnostic.
- Optional modules do not break DoD path when disabled.

## Expand before execution

Confirm device lab availability and official Cursor/VS Code CLI flags; then upgrade this file to full writing-plans granularity.
