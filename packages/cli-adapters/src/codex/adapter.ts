import { BaseAdapter } from '../base-adapter.js';
import { CodexEventParser } from './parse-events.js';
export class CodexAdapter extends BaseAdapter {
  readonly id = 'codex' as const;
  protected parser(): CodexEventParser { return new CodexEventParser(); }
}
