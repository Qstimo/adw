import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { AgentFailureCode } from '@adw/contracts';

export interface ProcessExit { code: number | null; signal: string | null; reason?: AgentFailureCode; detail?: string }
export type ProcessEvent = { type: 'line'; stream: 'stdout' | 'stderr'; line: string } | { type: 'heartbeat' } | { type: 'exit'; result: ProcessExit };
class EventQueue implements AsyncIterable<ProcessEvent> {
  private items: ProcessEvent[] = [];
  private wake?: () => void;
  private ended = false;
  constructor(private readonly limit: number) {}
  push(item: ProcessEvent): boolean {
    if (this.ended) return true;
    if (this.items.length >= this.limit) return false;
    this.items.push(item); this.wake?.(); return true;
  }
  finish(result: ProcessExit): void {
    if (this.ended) return;
    this.items.push({ type: 'exit', result }); this.ended = true; this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<ProcessEvent> {
    while (true) {
      const item = this.items.shift();
      if (item) { yield item; continue; }
      if (this.ended) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

export interface ProcessInput {
  sessionId: string; binaryPath: string; args: string[]; cwd: string; stdin: string;
  env: NodeJS.ProcessEnv; timeoutMs: number; heartbeatMs: number;
  maxOutputBytes: number; maxQueuedEvents: number;
  onRaw: (stream: 'stdout' | 'stderr', content: Buffer) => void;
}
export interface ProcessHandle {
  events: AsyncIterable<ProcessEvent>;
  done: Promise<ProcessExit>;
  stop(reason?: AgentFailureCode): Promise<ProcessExit>;
}

async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    return;
  }
  // Windows requires separate host validation; it is never advertised as verified.
  await new Promise<void>((resolve, reject) => {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', reject);
    killer.on('close', code => code === 0 ? resolve() : reject(new Error(`taskkill exited ${code}`)));
  });
}

export class ProcessRunner {
  private running = new Map<string, ProcessHandle>();
  async cancel(sessionId: string): Promise<void> { await this.running.get(sessionId)?.stop('cancelled'); }
  start(input: ProcessInput): ProcessHandle {
    if (this.running.has(input.sessionId)) throw new Error('Session already active');
    for (const value of [input.timeoutMs, input.heartbeatMs, input.maxOutputBytes, input.maxQueuedEvents]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('Invalid process limits');
    }
    const queue = new EventQueue(input.maxQueuedEvents);
    let finish!: (result: ProcessExit) => void;
    const done = new Promise<ProcessExit>(resolve => { finish = resolve; });
    let reason: AgentFailureCode | undefined, detail: string | undefined;
    let finished = false, totalBytes = 0;
    let cleanup: Promise<void> | undefined;
    const child = spawn(input.binaryPath, input.args, {
      cwd: input.cwd, env: input.env, shell: false, detached: process.platform !== 'win32',
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const cleanupTree = () => cleanup ??= killTree(child).catch(error => {
      reason ??= 'signal'; detail = `Process cleanup failed: ${String(error)}`;
    });
    const stop = async (requested: AgentFailureCode = 'cancelled') => {
      if (!finished) { reason ??= requested; await cleanupTree(); }
      return done;
    };
    const emit = (event: ProcessEvent) => {
      if (!queue.push(event)) void stop('queue_limit');
    };
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const buffers = { stdout: '', stderr: '' };
    const consume = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      if (finished || reason) return;
      const remaining = Math.max(0, input.maxOutputBytes - totalBytes);
      totalBytes += chunk.length;
      const bounded = chunk.subarray(0, remaining);
      try { input.onRaw(stream, bounded); }
      catch (error) { detail = String(error); void stop('io_error'); return; }
      buffers[stream] += decoders[stream].write(bounded);
      // Every line is bounded as well as the complete run, even without newlines.
      if (buffers[stream].length > 1024 * 1024) { void stop('output_limit'); return; }
      let end: number;
      while ((end = buffers[stream].indexOf('\n')) !== -1) {
        const line = buffers[stream].slice(0, end).replace(/\r$/, '');
        buffers[stream] = buffers[stream].slice(end + 1);
        emit({ type: 'line', stream, line });
        if (reason) break;
      }
      if (totalBytes > input.maxOutputBytes) void stop('output_limit');
    };
    child.stdout.on('data', (data: Buffer) => consume('stdout', data));
    child.stderr.on('data', (data: Buffer) => consume('stderr', data));
    child.on('error', error => { reason ??= 'spawn_error'; detail = error.message; });
    child.stdin.on('error', error => {
      // Early process exit closes stdin. Its exit/final event still decides success.
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') { detail = String(error); void stop('io_error'); }
    });
    const deadline = setTimeout(() => { void stop('timeout'); }, input.timeoutMs);
    const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), input.heartbeatMs);
    // Background descendants must not keep pipes open after the CLI exits.
    child.on('exit', () => { void cleanupTree(); });
    child.on('close', (code, signal) => {
      void (async () => {
        clearTimeout(deadline); clearInterval(heartbeat);
        await cleanupTree();
        for (const stream of ['stdout', 'stderr'] as const) {
          buffers[stream] += decoders[stream].end();
          if (buffers[stream] && !reason) emit({ type: 'line', stream, line: buffers[stream].replace(/\r$/, '') });
        }
        finished = true;
        const result: ProcessExit = { code, signal, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) };
        queue.finish(result); this.running.delete(input.sessionId); finish(result);
      })();
    });
    const handle: ProcessHandle = { events: queue, done, stop };
    this.running.set(input.sessionId, handle);
    child.stdin.end(input.stdin);
    return handle;
  }
}
