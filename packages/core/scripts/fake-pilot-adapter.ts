import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter, SessionInput } from '@adw/cli-adapters';
import { SessionIdSchema, type CapabilityManifest, type AgentEvent } from '@adw/contracts';
export const pilotGit = (cwd: string, ...args: string[]): Promise<string> => new Promise((resolve, reject) => execFile('git', args, { cwd, encoding: 'utf8' }, (error, out) => error ? reject(error) : resolve(out.trim())));
/** Deterministic fixture executor; it never discovers or calls an installed CLI/model. */
export class FakePilotAdapter implements AgentAdapter {
    readonly id = 'codex' as const;
    async discover() { return { binaryPath: 'in-process-fake-pilot', version: 'fixture-v1' }; }
    async probeCapabilities(): Promise<CapabilityManifest> { return { agentId: this.id, execution: { headless: 'supported', cwd: 'supported' }, session: { resume: 'unsupported', sessionId: 'supported' }, output: { format: 'jsonl', finalStatus: 'supported', errors: 'supported' }, tools: { mcp: 'unsupported', permissions: 'unknown', sandbox: 'unsupported' }, usage: { tokens: 'unsupported', cost: 'unsupported', limits: 'unknown' }, control: { cancel: 'supported', timeout: 'supported', processTreeCleanup: 'supported' } }; }
    private cancelled = new Set<string>();
    async cancel(sessionId: string) { this.cancelled.add(sessionId); }
    async *startSession(input: SessionInput): AsyncIterable<AgentEvent> {
        const sessionId = SessionIdSchema.parse(randomUUID()), base = { sessionId, at: new Date().toISOString() };
        yield { ...base, type: 'session_started', agentId: this.id };
        if (this.cancelled.has(sessionId))
            return;
        if(input.role==='reviewer'){yield {...base,type:'completed',summary:JSON.stringify({category:input.prompt.includes('Review pass: security')?'security':'code',remarks:[]})};return;}
        appendFileSync(join(input.worktreePath, 'src/add.ts'), '\n// Headless ADW pilot: arithmetic behavior remains covered by independent checks.\n');
        await pilotGit(input.worktreePath, 'add', 'src/add.ts');
        if (this.cancelled.has(sessionId))
            return;
        await pilotGit(input.worktreePath, '-c', 'user.name=ADW Pilot', '-c', 'user.email=adw-pilot@test', 'commit', '-m', 'pilot: document verified arithmetic');
        if (!this.cancelled.has(sessionId))
            yield { ...base, type: 'completed', summary: 'Fixture edit committed; independent verification required' };
    }
}
