import { z } from 'zod';
import { TaskIdSchema, CommitSchema, HashSchema, NonEmptyStringSchema } from './ids.js';
export const BaseCommitSchema = z.object({ baseBranch: NonEmptyStringSchema, baseCommit: CommitSchema }).strict();
export const WorktreeSchema = z.object({ taskId: TaskIdSchema, path: NonEmptyStringSchema, baseCommit: CommitSchema }).strict();
export const PatchSnapshotSchema = z.object({ taskId: TaskIdSchema, baseCommit: CommitSchema, headCommit: CommitSchema, patchHash: HashSchema }).strict();
export const PatchAcceptanceSchema = z.discriminatedUnion('status', [
 z.object({ taskId: TaskIdSchema, status: z.literal('accepted'), branch: z.string().startsWith('adw/accept/'), commit: CommitSchema }).strict(),
 z.object({ taskId: TaskIdSchema, status: z.literal('rejected'), reason: NonEmptyStringSchema }).strict()
]);
export type Worktree = z.infer<typeof WorktreeSchema>;
export type PatchSnapshot = z.infer<typeof PatchSnapshotSchema>;
export type PatchAcceptance = z.infer<typeof PatchAcceptanceSchema>;
