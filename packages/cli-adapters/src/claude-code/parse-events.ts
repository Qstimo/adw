import { z } from 'zod';
import { EnvelopeSchema, CountSchema, UsageSchema, bindSession, tokenTotal, unknownEvent, type EventParser, type ProtocolEvent, type TerminalResult } from '../protocol.js';

const BlocksSchema = z.array(z.object({ type: z.string().min(1) }).passthrough());
export class ClaudeCodeEventParser implements EventParser {
  providerSessionId?: string;
  terminal?: TerminalResult;
  parse(value: unknown): ProtocolEvent[] {
    const event = EnvelopeSchema.parse(value);
    if (event.session_id !== undefined) bindSession(this, z.string().min(1).parse(event.session_id));
    if (event.type === 'system' && event.subtype === 'init') {
      bindSession(this, z.string().min(1).parse(event.session_id));
      return unknownEvent(event);
    }
    if (event.type === 'assistant' || event.type === 'user') {
      const message = z.object({ content: z.union([z.string(), BlocksSchema]) }).passthrough().parse(event.message);
      if (typeof message.content === 'string') return [{ type: 'log', stream: 'stdout', message: message.content }];
      const events: ProtocolEvent[] = [];
      for (const block of message.content) {
        if (block.type === 'text') events.push({ type: 'log', stream: 'stdout', message: z.string().parse(block.text) });
        else if (block.type === 'tool_use') events.push({ type: 'tool_call', callId: z.string().min(1).parse(block.id), name: z.string().min(1).parse(block.name), input: block.input });
        else if (block.type === 'tool_result') events.push({ type: 'tool_result', callId: z.string().min(1).parse(block.tool_use_id), output: block });
      }
      return events;
    }
    if (event.type === 'result') {
      const result = z.object({
        subtype: z.string().min(1), is_error: z.boolean(), result: z.string().optional(),
        errors: z.array(z.string()).optional(), usage: UsageSchema.extend({ cache_read_input_tokens: CountSchema.optional(), cache_creation_input_tokens: CountSchema.optional() }).optional(),
        total_cost_usd: z.number().nonnegative().finite().optional(),
        permission_denials: z.array(z.unknown()).optional(), num_turns: CountSchema.optional(),
      }).passthrough().parse(event);
      const denied = (result.permission_denials?.length ?? 0) > 0;
      if (result.is_error || result.subtype !== 'success' || denied) {
        this.terminal = { ok: false, summary: denied ? 'Tool permission denied' : result.errors?.join('; ') || result.result || result.subtype, code: denied ? 'permission_denied' : 'provider_error' };
      } else if (this.terminal?.ok !== false) {
        this.terminal = { ok: true, summary: z.string().parse(result.result) };
      }
      const uncachedTokens = result.usage ? tokenTotal(result.usage) : undefined;
      // Anthropic cache input counts are separate; Codex cached input is a subset.
      const tokens = uncachedTokens === undefined ? undefined : uncachedTokens + (result.usage?.cache_read_input_tokens ?? 0) + (result.usage?.cache_creation_input_tokens ?? 0);
      if (tokens !== undefined && !Number.isSafeInteger(tokens)) throw new Error('Invalid usage count');
      if (tokens === undefined && result.total_cost_usd === undefined) return [];
      return [{ type: 'usage', ...(tokens !== undefined ? { tokens, inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens } : {}), ...(result.usage?.cache_read_input_tokens !== undefined ? { cachedInputTokens: result.usage.cache_read_input_tokens } : {}), ...(result.usage?.cache_creation_input_tokens !== undefined ? { cacheCreationInputTokens: result.usage.cache_creation_input_tokens } : {}), ...(result.total_cost_usd !== undefined ? { cost: result.total_cost_usd } : {}) }];
    }
    if (event.type === 'error') {
      this.terminal = { ok: false, summary: z.string().min(1).parse(event.message), code: 'provider_error' };
    }
    return unknownEvent(event);
  }
}
