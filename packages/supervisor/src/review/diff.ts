import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PatchSnapshotSchema, type PatchSnapshot, type Worktree } from '@adw/contracts';
import { capturePatchSnapshot, samePatchSnapshot, type GitWorktreeManager } from '@adw/git';
import {isVerificationTestPath,type EvidenceStore} from '@adw/verifier';
export interface ChangedFile {
    path: string;
    oldPath?: string;
    binary: boolean;
    isTestPath: boolean;
}
export interface ReviewDiff {
    snapshot: PatchSnapshot;
    unified: string;
    files: ChangedFile[];
    diffRef: string;
    metadataRef: string;
}
export const isTestPath=isVerificationTestPath;
async function git(cwd: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'])
        delete (env as NodeJS.ProcessEnv)[key];
    return new Promise((resolve, reject) => execFile('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 30000, signal }, (error, out) => error ? reject(error) : resolve(out)));
}
export async function collectReviewDiff(manager: GitWorktreeManager, worktree: Worktree, expected: PatchSnapshot, evidence: EvidenceStore, signal?: AbortSignal): Promise<ReviewDiff> {
    const snapshot = PatchSnapshotSchema.parse(expected);
    if (!samePatchSnapshot(snapshot, await capturePatchSnapshot(manager, worktree)))
        throw new Error('Review snapshot differs from verified patch');
    const raw = (await git(worktree.path, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--binary', snapshot.baseCommit, snapshot.headCommit, '--'], signal)).toString('utf8');
    if (createHash('sha256').update(raw).digest('hex') !== snapshot.patchHash)
        throw new Error('Review diff differs from verified hash');
    const bytes = await git(worktree.path, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--numstat', '-z', snapshot.baseCommit, snapshot.headCommit, '--'], signal);
    const tokens = bytes.toString('utf8').split('\0');
    const files: ChangedFile[] = [];
    for (let i = 0; i < tokens.length && tokens[i]; i++) {
        const record = tokens[i]!, first = record.indexOf('\t'), second = record.indexOf('\t', first + 1);
        if (first < 0 || second < 0)
            throw new Error('Malformed Git numstat');
        const added = record.slice(0, first), removed = record.slice(first + 1, second);
        let path = record.slice(second + 1), oldPath: string | undefined;
        if (!path) {
            oldPath = tokens[++i];
            path = tokens[++i] ?? '';
        }
        if (!path || files.length >= 10000)
            throw new Error('Invalid/oversized review file list');
        files.push({ path, ...(oldPath ? { oldPath } : {}), binary: added === '-' || removed === '-', isTestPath: isTestPath(path) || !!oldPath && isTestPath(oldPath) });
    }
    const unified = (await git(worktree.path, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--unified=3', snapshot.baseCommit, snapshot.headCommit, '--'], signal)).toString('utf8');
    if (!samePatchSnapshot(snapshot, await capturePatchSnapshot(manager, worktree)))
        throw new Error('Patch changed while collecting review');
    return { snapshot, unified, files, diffRef: evidence.put(raw), metadataRef: evidence.put(JSON.stringify({ snapshot, files, unified })) };
}
