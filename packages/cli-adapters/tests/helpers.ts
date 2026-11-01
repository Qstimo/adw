import { chmodSync, cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent } from '@adw/contracts';
import { ClaudeCodeAdapter, CodexAdapter, type AgentAdapter, type AdapterOptions, type AgentId } from '../src/index.js';
export function fixture(id: AgentId, extra: AdapterOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'adw cli '));
  const files = join(root, 'fake');
  cpSync(fileURLToPath(new URL('./fixtures', import.meta.url)), files, { recursive: true });
  for (const file of ['fake-codex.mjs', 'fake-claude.mjs']) chmodSync(join(files, file), 0o700);
  const worktreePath = join(root, 'worktree'); mkdirSync(worktreePath);
  const binaryPath = join(files, id === 'codex' ? 'fake-codex.mjs' : 'fake-claude.mjs');
  const options: AdapterOptions = { logDir: join(root, 'logs'), heartbeatMs: 40, ...extra, env: { ...extra.env, [id === 'codex' ? 'ADW_CODEX_PATH' : 'ADW_CLAUDE_PATH']: binaryPath } };
  const adapter: AgentAdapter = id === 'codex' ? new CodexAdapter(options) : new ClaudeCodeAdapter(options);
  return { root, worktreePath, binaryPath, adapter, options };
}
export async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
