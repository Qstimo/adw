import { BaseAdapter } from '../base-adapter.js';
import { ClaudeCodeEventParser } from './parse-events.js';
export class ClaudeCodeAdapter extends BaseAdapter {
  readonly id = 'claude-code' as const;
  protected parser(): ClaudeCodeEventParser { return new ClaudeCodeEventParser(); }
}
