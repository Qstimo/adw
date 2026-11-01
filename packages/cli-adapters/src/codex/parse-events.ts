import { z } from 'zod';
import { EnvelopeSchema, UsageSchema, CountSchema, bindSession, tokenTotal, unknownEvent, type EventParser, type ProtocolEvent, type TerminalResult } from '../protocol.js';

const ItemSchema = z.object({ id: z.string().min(1), type: z.string().min(1) }).passthrough();
export class CodexEventParser implements EventParser {
  providerSessionId?: string;
  terminal?: TerminalResult;
  private summary = '';
  parse(value: unknown): ProtocolEvent[] {
    const event = EnvelopeSchema.parse(value);
    if (event.type === 'thread.started') {
      bindSession(this, z.string().min(1).parse(event.thread_id));
      return unknownEvent(event);
    }
    if (event.type === 'error' || event.type === 'turn.failed') {
      const error = event.type === 'error' ? event : z.object({ message: z.string().min(1) }).passthrough().parse(event.error);
      this.terminal = { ok: false, summary: z.string().min(1).parse(error.message), code: 'provider_error' };
      return unknownEvent(event);
    }
    if (event.type === 'turn.completed') {
      const usage = UsageSchema.extend({ cached_input_tokens: CountSchema.optional() }).parse(event.usage ?? {});
      if (this.terminal?.ok !== false) this.terminal = { ok: true, summary: this.summary };
      const tokens = tokenTotal(usage);
      return tokens === undefined ? [] : [{ type: 'usage', tokens, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, ...(usage.cached_input_tokens !== undefined ? { cachedInputTokens: usage.cached_input_tokens } : {}) }];
    }
    if (['item.started', 'item.updated', 'item.completed'].includes(event.type)) {
      const item = ItemSchema.parse(event.item);
      if (item.type === 'agent_message') {
        const text = z.string().parse(item.text);
        if (event.type === 'item.completed') this.summary = text;
        return [{ type: 'log', stream: 'stdout', message: text }];
      }
      const tools = ['command_execution', 'mcp_tool_call', 'file_change', 'web_search'];
      if (tools.includes(item.type)) {
        if (event.type === 'item.started') return [{ type: 'tool_call', callId: item.id, name: item.type, input: item }];
        if (event.type === 'item.completed') return [{ type: 'tool_result', callId: item.id, output: item }];
      }
    }
    return unknownEvent(event);
  }
}
