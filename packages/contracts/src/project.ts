import { z } from 'zod';
import { ProjectIdSchema, TimestampSchema, NonEmptyStringSchema } from './ids.js';
export const ProjectSchema = z.object({ id: ProjectIdSchema, path: NonEmptyStringSchema, defaultBaseBranch: NonEmptyStringSchema, createdAt: TimestampSchema }).strict();
export type Project = z.infer<typeof ProjectSchema>;
