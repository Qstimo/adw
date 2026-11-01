import { z } from 'zod';
import { TaskIdSchema, ProjectIdSchema, CommitSchema, NonEmptyStringSchema } from './ids.js';
export const TaskStatusSchema = z.enum(['draft','locked','queued','running','verifying','reviewing','ready_for_review','accepted','rejected','failed','cancelled','needs_human']);
export const AcceptanceSchema = z.array(NonEmptyStringSchema).min(1);
export const TaskSpecSchema = z.object({ id: TaskIdSchema, projectId: ProjectIdSchema, intent: NonEmptyStringSchema, acceptance: AcceptanceSchema, outOfScope: z.array(NonEmptyStringSchema), baseBranch: NonEmptyStringSchema, baseCommit: CommitSchema, status: TaskStatusSchema }).strict();
export const DagNodeSchema = z.object({ id: NonEmptyStringSchema, taskId: TaskIdSchema, dependsOn: z.array(NonEmptyStringSchema), status: TaskStatusSchema }).strict();
export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type DagNode = z.infer<typeof DagNodeSchema>;
