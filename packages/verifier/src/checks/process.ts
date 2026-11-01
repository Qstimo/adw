import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
function killDetachedChildren(parent: number): void {
    if (process.platform !== 'linux')
        return;
    const children = new Map<number, {
        pid: number;
        start: string;
    }[]>();
    for (const name of readdirSync('/proc')) {
        if (!/^\d+$/.test(name))
            continue;
        try {
            const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '), ppid = Number(fields[1]);
            const list = children.get(ppid) ?? [];
            list.push({ pid: Number(name), start: fields[19]! });
            children.set(ppid, list);
        }
        catch {
        }
    }
    const visited = new Set<number>();
    const walk = (pid: number) => {
        if (visited.has(pid) || visited.size > 10000)
            return;
        visited.add(pid);
        for (const child of children.get(pid) ?? []) {
            walk(child.pid);
            try {
                const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
                if (stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === child.start)
                    process.kill(child.pid, 'SIGKILL');
            }
            catch (error) {
                if (!['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? ''))
                    throw error;
            }
        }
    };
    walk(parent);
}
export interface ProcessOutcome {
    code: number | null;
    reason: string;
    stdout: string;
    stderr: string;
}
export interface ManagedProcess {
    done: Promise<ProcessOutcome>;
    stop(reason?: string): Promise<ProcessOutcome>;
    alive(): boolean;
}
export function startProcess(input: {
    cwd: string;
    command?: string;
    binary?: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    stdin?: string;
    maxBytes?: number;
    onStdout?: (text: string) => void;
}): ManagedProcess {
    if (input.signal?.aborted) {
        const done = Promise.resolve({ code: null, reason: 'cancelled', stdout: '', stderr: '' });
        return { done, stop: () => done, alive: () => false };
    }
    let reason = '', alive = true, bytes = 0;
    const out: Buffer[] = [], err: Buffer[] = [];
    const child = spawn(input.command ?? input.binary!, input.command ? [] : input.args ?? [], { cwd: input.cwd, env: input.env ?? process.env, shell: !!input.command, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const kill = () => {
        if (!child.pid)
            return;
        try {
            if (process.platform === 'win32') {
                const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
                killer.on('error', () => {
                });
            }
            else
                process.kill(-child.pid, 'SIGKILL');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
                reason = 'cleanup_error';
        }
    };
    const interrupt = (value: string) => {
        reason ||= value;
        if (child.pid)
            try {
                killDetachedChildren(child.pid);
            }
            catch {
                reason = 'cleanup_error';
            }
        kill();
    };
    const abort = () => interrupt('cancelled');
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted)
        abort();
    const timer = setTimeout(() => interrupt('timeout'), input.timeoutMs);
    const capture = (chunks: Buffer[], chunk: Buffer, stdout: boolean) => {
        const remaining = Math.max(0, (input.maxBytes ?? 65536) - bytes);
        bytes += chunk.length;
        if (remaining) {
            const part = chunk.subarray(0, remaining);
            chunks.push(part);
            if (stdout)
                try {
                    input.onStdout?.(part.toString('utf8'));
                }
                catch {
                    interrupt('protocol_error');
                }
        }
        if (bytes > (input.maxBytes ?? 65536))
            interrupt('output_limit');
    };
    child.stdout.on('data', (chunk: Buffer) => capture(out, chunk, true));
    child.stderr.on('data', (chunk: Buffer) => capture(err, chunk, false));
    child.stdin.on('error', () => {
    });
    child.stdin.end(input.stdin ?? '');
    child.on('error', error => {
        reason = 'spawn_error';
        err.push(Buffer.from(error.message));
    });
    child.on('exit', () => {
        alive = false;
        kill();
    });
    const done = new Promise<ProcessOutcome>(resolve => child.on('close', code => {
        alive = false;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', abort);
        kill();
        resolve({ code, reason, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    }));
    return { done, alive: () => alive, stop: async (value = 'cancelled') => {
            if (alive)
                interrupt(value);
            return done;
        } };
}
