import type { AgentEvent, CapabilityManifest } from '@adw/contracts';

export type AgentId = 'codex' | 'claude-code';
export interface DiscoveredAgent { binaryPath: string; version: string }
export interface SessionInput {
  worktreePath: string;
  prompt: string;
  bundlePath?: string;
  timeoutMs: number;
  resumeSessionId?: string;
  signal?: AbortSignal;
  role?: 'executor' | 'reviewer';
}
export interface AgentAdapter {
  readonly id: AgentId;
  discover(signal?: AbortSignal): Promise<DiscoveredAgent>;
  probeCapabilities(version: string, signal?: AbortSignal): Promise<CapabilityManifest>;
  startSession(input: SessionInput): AsyncIterable<AgentEvent>;
  cancel(sessionId: string): Promise<void>;
}
export interface AdapterOptions {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  logDir?: string;
  heartbeatMs?: number;
  maxOutputBytes?: number;
  maxQueuedEvents?: number;
}
