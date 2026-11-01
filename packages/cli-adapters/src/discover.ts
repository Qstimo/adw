import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProcessRunner } from './process-runner.js';
import type { AgentId, DiscoveredAgent } from './types.js';

export async function findBinary(name: string, env: NodeJS.ProcessEnv, override?: string): Promise<string> {
  const candidates = override ? [resolve(override)] : (env.PATH ?? '').split(delimiter)
    .filter(Boolean).map(dir => resolve(dir, name));
  for (const file of candidates) {
    try {
      await access(file, constants.X_OK);
      return await realpath(file);
    } catch { /* Continue PATH search; explicit overrides never fall back. */ }
  }
  throw new Error(`Executable not found: ${override ?? name}`);
}

export async function capture(binaryPath: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 5000, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!isAbsolute(binaryPath)) throw new Error('Expected absolute executable path');
  const stdout: Buffer[] = [];
  const handle = new ProcessRunner().start({
    sessionId: randomUUID(), binaryPath, args, env, cwd: process.cwd(), stdin: '',
    timeoutMs, heartbeatMs: 1000, maxOutputBytes: 256 * 1024, maxQueuedEvents: 4096,
    onRaw: (stream, content) => { if (stream === 'stdout') stdout.push(content); },
  });
  const abort=()=>{void handle.stop('cancelled');};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let exit;
  try{for await (const _event of handle.events) { /* Drain the bounded probe event queue. */ }exit=await handle.done;}
  finally{signal?.removeEventListener('abort',abort);}
  signal?.throwIfAborted();
  if (exit.reason || exit.signal || exit.code !== 0) {
    throw Object.assign(new Error(`CLI probe failed: ${exit.detail || exit.reason || exit.signal || exit.code}`), { killed: exit.reason === 'timeout' });
  }
  return Buffer.concat(stdout).toString('utf8');
}

export async function discoverAgent(id: AgentId, env: NodeJS.ProcessEnv, override?: string, timeoutMs = 5000, signal?: AbortSignal): Promise<DiscoveredAgent> {
  signal?.throwIfAborted();
  const name = id === 'codex' ? 'codex' : 'claude';
  const configured = override ?? env[id === 'codex' ? 'ADW_CODEX_PATH' : 'ADW_CLAUDE_PATH'];
  const binaryPath = await findBinary(name, env, configured);
  const output = (await capture(binaryPath, ['--version'], env, timeoutMs,signal)).trim();
  const pattern = id === 'codex' ? /^codex-cli (\d+\.\d+\.\d+(?:-[\w.-]+)?)$/ : /^(\d+\.\d+\.\d+(?:-[\w.-]+)?) \(Claude Code\)$/;
  const version = output.match(pattern)?.[1];
  if (!version) throw new Error(`Unrecognized ${id} version output`);
  return { binaryPath, version };
}
