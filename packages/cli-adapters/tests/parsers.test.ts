import { expect, it } from 'vitest';
import { CodexEventParser } from '../src/codex/parse-events.js';
import { ClaudeCodeEventParser } from '../src/claude-code/parse-events.js';
it('Codex validates known fields, preserves unknown events and never overwrites a failure with success', () => {
  const parser = new CodexEventParser();
  expect(() => parser.parse({ type: 'thread.started' })).toThrow();
  parser.parse({ type: 'thread.started', thread_id: 'session_1' });
  expect(() => parser.parse({ type: 'thread.started', thread_id: 'session_2' })).toThrow('changed');
  expect(parser.parse({ type: 'future.event', data: 1 })[0]).toMatchObject({ type: 'log' });
  parser.parse({ type: 'error', message: 'authentication required' });
  parser.parse({ type: 'turn.completed' });
  expect(parser.terminal).toMatchObject({ ok: false, code: 'provider_error' });
});
it('Claude validates result payloads and preserves provider failure details', () => {
  const parser = new ClaudeCodeEventParser();
  expect(() => parser.parse({ type: 'result', subtype: 'success', result: 'x' })).toThrow();
  parser.parse({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 'session_1', errors: ['turn limit'] });
  parser.parse({ type: 'result', subtype: 'success', is_error: false, session_id: 'session_1', result: 'later' });
  expect(parser.terminal).toMatchObject({ ok: false, summary: 'turn limit' });
});
it('does not invent tokens/cost when a CLI omits usage and rejects invalid counters', () => {
  const codex = new CodexEventParser(), claude = new ClaudeCodeEventParser();
  expect(codex.parse({ type: 'turn.completed' })).toEqual([]);
  expect(claude.parse({ type: 'result', subtype: 'success', is_error: false, result: 'x' })).toEqual([]);
  expect(() => codex.parse({ type: 'turn.completed', usage: { input_tokens: -1, output_tokens: 0 } })).toThrow();
  expect(() => claude.parse({ type: 'result', subtype: 'success', is_error: false, result: 'x', total_cost_usd: -1 })).toThrow();
});
it('keeps provider cache counters without counting Codex cached input twice', () => {
  const codex = new CodexEventParser(), claude = new ClaudeCodeEventParser();
  expect(codex.parse({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 3 } })).toEqual([{type:'usage',tokens:12,inputTokens:10,outputTokens:2,cachedInputTokens:3}]);
  expect(claude.parse({ type:'result',subtype:'success',is_error:false,result:'x',usage:{input_tokens:10,output_tokens:2,cache_read_input_tokens:100,cache_creation_input_tokens:20} })).toEqual([{type:'usage',tokens:132,inputTokens:10,outputTokens:2,cachedInputTokens:100,cacheCreationInputTokens:20}]);
});
