import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ProjectIndexer, isInside } from '@adw/context';
import { Supervisor, type SupervisorOptions } from '@adw/supervisor';
import { ContextFacade } from './context-facade.js';
export function createSupervisor(input: Omit<SupervisorOptions, 'createContext'> & {
    dataDir: string;
}): Supervisor {
    const dataDir = resolve(input.dataDir);
    if (isInside(input.manager.repoPath, dataDir))
        throw new Error('Supervisor data directory must be outside the repository');
    mkdirSync(dataDir, { recursive: true });
    if (isInside(input.manager.repoPath, realpathSync(dataDir)))
        throw new Error('Supervisor data directory resolves inside the repository');
    return new Supervisor({ ...input, createContext: async (worktree) => {
            const project = input.db.prepare('SELECT project_id FROM tasks WHERE id=?').get(worktree.taskId) as {
                project_id: string;
            };
            const directory = join(dataDir, 'indexes', createHash('sha256').update(project.project_id + '\0' + worktree.path).digest('hex'));
            mkdirSync(directory, { recursive: true });
            const index = await ProjectIndexer.build({ projectId: project.project_id, repoPath: worktree.path, baseCommit: worktree.baseCommit, dbPath: join(directory, 'index.sqlite') });
            try {
                const facade = await ContextFacade.create(input.db, index, { dataDir, evidenceStore: input.verifier.evidenceStore, worktree });
                return { buildBundle: request => facade.forTask(worktree.taskId).read.buildBundle(request),
                    publishReviewFinding: (remark, refs, producer) => {
                        for (const ref of refs)
                            facade.store.blobs.put(input.verifier.evidenceStore.get(ref));
                        const file = remark.path ? index.getProjectMap().files.find(file => file.path === remark.path) : undefined;
                        return facade.forTask(worktree.taskId).write.publishFinding({ claim: remark.message, affectedPaths: remark.path ? [remark.path] : [], sourcePaths: file ? [file.path] : [], sourceHashes: file ? { [file.path]: file.contentHash } : {}, producerAgent: 'reviewer:' + producer, verificationStatus: remark.verificationStatus, evidenceRefs: refs }).id;
                    }, close: () => index.close() };
            }
            catch (error) {
                index.close();
                throw error;
            }
        } });
}
