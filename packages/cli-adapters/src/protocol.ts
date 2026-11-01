import { z } from 'zod';
import type { AgentFailureCode } from '@adw/contracts';

export type ProtocolEvent =
  | { type: 'log'; stream: 'stdout' | 'stderr'; message: string }
  | { type: 'tool_call'; callId: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; output: unknown }
  | { type: 'usage'; tokens?: number; cost?: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheCreationInputTokens?: number };
export interface TerminalResult { ok: boolean; summary: string; code?: AgentFailureCode }
export interface EventParser {
  providerSessionId?: string;
  terminal?: TerminalResult;
  parse(value: unknown): ProtocolEvent[];
}
export const EnvelopeSchema = z.object({ type: z.string().min(1) }).passthrough();
export const CountSchema = z.number().int().nonnegative().finite();
export const UsageSchema = z.object({ input_tokens: CountSchema.optional(), output_tokens: CountSchema.optional() }).passthrough();
export function tokenTotal(usage: z.infer<typeof UsageSchema>): number | undefined {
  if (usage.input_tokens === undefined || usage.output_tokens === undefined) return undefined;
  const total = usage.input_tokens + usage.output_tokens;
  if (!Number.isSafeInteger(total)) throw new Error('Invalid usage count');
  return total;
}
export function bindSession(parser: EventParser, sessionId: string): void {
  if (parser.providerSessionId && parser.providerSessionId !== sessionId) throw new Error('Provider session ID changed during a run');
  parser.providerSessionId = sessionId;
}
export function unknownEvent(value: unknown): ProtocolEvent[] {
  return [{ type: 'log', stream: 'stdout', message: JSON.stringify(value) }];
}
