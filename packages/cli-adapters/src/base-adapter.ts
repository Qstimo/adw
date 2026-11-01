import { randomUUID } from 'node:crypto';
import { realpath, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentEventSchema, CapabilityManifestSchema, ContextBundleSchema, type AgentEvent, type AgentFailureCode, type CapabilityManifest } from '@adw/contracts';
import type { AgentAdapter, AgentId, AdapterOptions, DiscoveredAgent, SessionInput } from './types.js';
import { capture, discoverAgent } from './discover.js';
import { loadCompatibility, type CompatibilityProfile } from './compat.js';
import { SessionJournal } from './journal.js';
import { ProcessRunner, type ProcessHandle, type ProcessExit } from './process-runner.js';
import type { EventParser } from './protocol.js';

const InputSchema = z.object({
  worktreePath: z.string().min(1), prompt: z.string().trim().min(1).max(1024 * 1024),
  bundlePath: z.string().min(1).optional(), timeoutMs: z.number().int().min(1).max(2_147_483_647),
  resumeSessionId: z.string().uuid().optional(),
  signal: z.custom<AbortSignal>(value=>value instanceof AbortSignal).optional(),
  role: z.enum(['executor','reviewer']).optional(),
}).strict();
class AdapterError extends Error {
  constructor(readonly code: AgentFailureCode, message: string) { super(message); }
}

export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly id: AgentId;
  protected abstract parser(): EventParser;
  private runner = new ProcessRunner();
  protected readonly env: NodeJS.ProcessEnv;
  readonly logDir: string;
  constructor(protected readonly options: AdapterOptions = {}) {
    this.env = { ...process.env, ...options.env };
    this.logDir = options.logDir ?? join(tmpdir(), 'adw-cli-sessions');
  }
  discover(signal?:AbortSignal): Promise<DiscoveredAgent> { return discoverAgent(this.id, this.env, this.options.binaryPath,5000,signal); }
  private async inspect(found: DiscoveredAgent, deadline: number,signal?:AbortSignal): Promise<CompatibilityProfile> {
    const profile = await loadCompatibility(this.id, found.version);
    if (profile.version === null) return profile;
    for (const mode of ['start', 'resume'] as const) {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining < 1) throw new AdapterError('timeout', 'Timeout during capability probe');
      const help = await capture(found.binaryPath, profile.help[mode], this.env, Math.min(5000, remaining),signal);
      const required = mode === 'start' ? profile.help.requiredStart : profile.help.requiredResume;
      if (!required.every(flag => help.includes(flag))) throw new AdapterError('capability_mismatch', `${this.id} ${found.version}: ${mode} help differs from compatibility profile`);
    }
    return profile;
  }
  async probeCapabilities(version: string,signal?:AbortSignal): Promise<CapabilityManifest> {
    const found = await this.discover(signal);
    if (found.version !== version) throw new Error('Installed CLI version changed');
    const profile = await this.inspect(found, Date.now() + 15_000,signal);
    const capabilities = structuredClone(profile.capabilities);
    capabilities.control.processTreeCleanup = process.platform === 'linux' ? 'supported' : 'unknown';
    return CapabilityManifestSchema.parse(capabilities);
  }
  cancel(sessionId: string): Promise<void> { return this.runner.cancel(sessionId); }

  async *startSession(input: SessionInput): AsyncGenerator<AgentEvent> {
    const sessionId = randomUUID(), startedAt = new Date().toISOString();
    const parser = this.parser();
    let journal: SessionJournal | undefined, handle: ProcessHandle | undefined;
    let found: DiscoveredAgent | undefined, cwd: string | undefined, exit: ProcessExit | undefined;
    let terminal: AgentEvent | undefined;
    let stage: AgentFailureCode = 'invalid_input';
    const abort=()=>{if(handle)void handle.stop('cancelled');};
    const event = (value: object): AgentEvent => AgentEventSchema.parse({
      ...value, sessionId, at: new Date().toISOString(),
      ...(parser.providerSessionId ? { providerSessionId: parser.providerSessionId } : {}),
    });
    const record = (value: object) => {
      const parsed = event(value);
      try { journal?.event(parsed); }
      catch (error) { throw new AdapterError('io_error', String(error)); }
      return parsed;
    };
    const metadata = (result: AgentEvent) => journal?.metadata({
      agentId: this.id, sessionId, providerSessionId: parser.providerSessionId,
      startedAt, endedAt: result.at, binaryPath: found?.binaryPath, version: found?.version,
      cwd, exit, result,
    });
    try {
      InputSchema.parse(input); // Validate without changing the user's prompt whitespace.
      input.signal?.throwIfAborted();
      const deadline = Date.now() + input.timeoutMs;
      stage = 'io_error';
      journal = new SessionJournal(this.logDir, sessionId);
      stage = 'invalid_input';
      cwd = await realpath(input.worktreePath);
      if (!(await stat(cwd)).isDirectory()) throw new Error('Worktree must be a directory');
      let prompt = input.prompt;
      if (input.bundlePath) {
        const file = await stat(input.bundlePath);
        if (!file.isFile() || file.size > 1024 * 1024) throw new Error('Invalid context bundle file');
        const bundle = ContextBundleSchema.parse(JSON.parse(await readFile(input.bundlePath, 'utf8')));
        if (bundle.targetAgent !== this.id) throw new Error('Context bundle targets another agent');
        prompt += `\n\n<adw_context_bundle>\n${JSON.stringify(bundle)}\n</adw_context_bundle>`;
      }
      const remaining = () => {
        input.signal?.throwIfAborted();
        const ms = deadline - Date.now();
        if (ms < 1) throw new AdapterError('timeout', 'Timeout during session setup');
        return ms;
      };
      stage = 'discovery_failed';
      found = await discoverAgent(this.id, this.env, this.options.binaryPath, Math.min(5000, remaining()),input.signal);
      stage = 'capability_mismatch';
      const profile = await this.inspect(found, deadline,input.signal);
      if (profile.version === null || profile.protocol === 'unknown') throw new AdapterError('unsupported_version', `No tested event profile for ${this.id} ${found.version}`);
      if(input.role==='reviewer'&&input.resumeSessionId)throw new AdapterError('invalid_input','Reviewer cannot resume an executor session');
      if(input.role==='reviewer'){
        if(!profile.arguments.review||!profile.help.review||!profile.help.requiredReview)throw new AdapterError('capability_mismatch','No tested read-only review policy');
        const help=await capture(found.binaryPath,profile.help.review,this.env,Math.min(5000,remaining()),input.signal);
        if(!profile.help.requiredReview.every(flag=>help.includes(flag)))throw new AdapterError('capability_mismatch','Read-only review help differs from profile');
      }
      const args = (input.role==='reviewer'?profile.arguments.review!:input.resumeSessionId ? profile.arguments.resume : profile.arguments.start)
        .map(arg => arg === '{sessionId}' ? input.resumeSessionId! : arg);
      stage = 'io_error';
      journal.metadata({ agentId: this.id, sessionId, startedAt, binaryPath: found.binaryPath, version: found.version, cwd, status: 'starting' });
      stage = 'spawn_error';
      input.signal?.throwIfAborted();
      handle = this.runner.start({
        sessionId, binaryPath: found.binaryPath, args, cwd, stdin: prompt, env: this.env,
        timeoutMs: remaining(), heartbeatMs: this.options.heartbeatMs ?? 1000,
        maxOutputBytes: this.options.maxOutputBytes ?? 16 * 1024 * 1024,
        maxQueuedEvents: this.options.maxQueuedEvents ?? 4096,
        onRaw: (stream, data) => journal!.raw(stream, data),
      });
      input.signal?.addEventListener('abort',abort,{once:true});if(input.signal?.aborted)abort();
      yield record({ type: 'session_started', agentId: this.id });
      stage = 'protocol_error';
      for await (const item of handle.events) {
        if (item.type === 'heartbeat') { yield record({ type: 'heartbeat' }); continue; }
        if (item.type === 'exit') { exit = item.result; break; }
        if (item.stream === 'stderr') { yield record({ type: 'log', stream: 'stderr', message: item.line }); continue; }
        if (!item.line.trim()) continue;
        const events = parser.parse(JSON.parse(item.line));
        if (input.resumeSessionId && parser.providerSessionId && parser.providerSessionId !== input.resumeSessionId) throw new Error('Resumed CLI returned another session ID');
        for (const normalized of events) yield record(normalized);
      }
      if (!exit) throw new Error('Missing process exit');
      let value: object;
      if (exit.reason) value = { type: 'failed', code: exit.reason, reason: exit.detail || exit.reason };
      else if (parser.terminal?.ok === false) value = { type: 'failed', code: parser.terminal.code ?? 'provider_error', reason: parser.terminal.summary };
      else if (exit.signal) value = { type: 'failed', code: 'signal', reason: `CLI terminated by ${exit.signal}` };
      else if (exit.code !== 0) value = { type: 'failed', code: 'exit_code', reason: `CLI exited ${exit.code}` };
      else if (!parser.providerSessionId || !parser.terminal) value = { type: 'failed', code: 'protocol_error', reason: 'CLI exited without a session ID and final result' };
      else value = { type: 'completed', summary: parser.terminal.summary };
      stage = 'io_error';
      const result = event(value);
      metadata(result); journal.event(result); terminal = result;
      yield result;
    } catch (error) {
      const code = input.signal?.aborted ? 'cancelled' : error instanceof AdapterError ? error.code : (error as { killed?: boolean })?.killed ? 'timeout' : stage;
      if (handle) exit = await handle.stop(code);
      const result = event({ type: 'failed', code: exit?.reason ?? code, reason: error instanceof Error ? error.message : String(error) });
      try { metadata(result); journal?.event(result); } catch { /* Logging failure is exposed by the failed session. */ }
      terminal = result;
      yield result;
    } finally {
      input.signal?.removeEventListener('abort',abort);
      if (handle && !terminal) {
        exit = await handle.stop('cancelled');
        const result = event({ type: 'failed', code: 'cancelled', reason: 'Event consumer closed the session' });
        try { metadata(result); journal?.event(result); } catch { /* Consumer has already closed. */ }
      }
    }
  }
}
