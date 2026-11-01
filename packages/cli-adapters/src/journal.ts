import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@adw/contracts';

export class SessionJournal {
  readonly directory: string;
  constructor(root: string, runId: string) {
    this.directory = join(root, runId);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(this.directory, { mode: 0o700 });
    for (const name of ['stdout.log', 'stderr.log', 'events.jsonl']) writeFileSync(join(this.directory, name), '', { flag: 'wx', mode: 0o600 });
  }
  raw(stream: 'stdout' | 'stderr', content: Buffer): void {
    appendFileSync(join(this.directory, `${stream}.log`), content);
  }
  event(event: AgentEvent): void { appendFileSync(join(this.directory, 'events.jsonl'), `${JSON.stringify(event)}\n`); }
  metadata(value: unknown): void {
    writeFileSync(join(this.directory, 'metadata.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  }
}
