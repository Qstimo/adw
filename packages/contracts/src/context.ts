import { z } from 'zod';
import { ArtifactIdSchema, ProjectIdSchema, TaskIdSchema, CommitSchema, HashSchema, TimestampSchema, SessionIdSchema, NonEmptyStringSchema } from './ids.js';
export const ConfidenceSchema = z.enum(['verified','inferred','unverified']);
// Validate own entries and rebuild data properties, preserving even a literal
// '__proto__' filename without invoking Object.prototype's setter.
export const SourceHashesSchema = z.custom<Record<string, unknown>>(
 value => value !== null && typeof value === 'object' && !Array.isArray(value),
 { message: 'Expected a source hash object' },
).transform(value => Object.entries(value))
 .pipe(z.array(z.tuple([z.string().min(1), HashSchema])))
 .transform(entries => Object.fromEntries(entries));
export const ContextArtifactSchema = z.object({
 id: ArtifactIdSchema, projectId: ProjectIdSchema, taskId: TaskIdSchema.optional(),
 kind: z.enum(['decision','convention','constraint','finding','summary','handoff','project_map','research']),
 contentRef: NonEmptyStringSchema, summaryRef: NonEmptyStringSchema.optional(), baseCommit: CommitSchema,
 sourcePaths: z.array(z.string().min(1)), sourceHashes: SourceHashesSchema,
 producerAgent: NonEmptyStringSchema, confidence: ConfidenceSchema, createdAt: TimestampSchema,
 expiresAt: TimestampSchema.optional(), invalidatedAt: TimestampSchema.optional(),
 visibility: z.enum(['project','task','session']), tokenEstimate: z.number().int().nonnegative(),
 evidenceRefs: z.array(NonEmptyStringSchema).optional(), sessionId: SessionIdSchema.optional(), logicalKey: NonEmptyStringSchema.optional()
}).strict().superRefine((value, ctx) => {
 for (const path of value.sourcePaths) {
  if (!Object.hasOwn(value.sourceHashes, path)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceHashes', path], message: 'Source path requires its own hash' });
 }
});
export const BundleSectionSchema = z.object({
 kind: z.enum(['artifact','source']), ref: NonEmptyStringSchema, content: z.string(),
 artifactId: ArtifactIdSchema.optional(), artifact: ContextArtifactSchema.optional(), confidence: ConfidenceSchema.optional(),
 path: z.string().min(1).optional(), contentHash: HashSchema.optional(),
 startLine: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(),
}).strict();
export const ContextBundleSchema = z.object({
 taskId: TaskIdSchema, targetAgent: NonEmptyStringSchema, baseCommit: CommitSchema,
 acceptance: z.array(z.string().refine(value => value.trim().length > 0, 'Acceptance must be nonempty')).min(1),
 selectedArtifacts: z.array(ArtifactIdSchema), sourceRefs: z.array(NonEmptyStringSchema), tokenBudget: z.number().int().positive(), generatedAt: TimestampSchema,
 projectId: ProjectIdSchema.optional(), indexSnapshotId: z.string().regex(/^idx_[a-f0-9]{64}$/).optional(),
 intent: z.string().optional(), outOfScope: z.array(z.string()).optional(), sections: z.array(BundleSectionSchema).optional(),
 estimatedTokens: z.number().int().nonnegative().optional(), overBudget: z.boolean().optional(), warnings: z.array(z.string()).optional(), cacheKey: HashSchema.optional(),
}).strict();
export type BundleSection = z.infer<typeof BundleSectionSchema>;
export const FindingSchema = z.object({ claim: z.string().refine(value => value.trim().length > 0, 'Finding claim must be nonempty'), evidenceRefs: z.array(NonEmptyStringSchema), affectedPaths: z.array(z.string().min(1)), verificationStatus: ConfidenceSchema }).strict().superRefine((value, ctx) => {
 if (value.verificationStatus === 'verified' && !value.evidenceRefs.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evidenceRefs'], message: 'Verified finding requires evidence' });
});
export type ContextArtifact = z.infer<typeof ContextArtifactSchema>;
export type ContextBundle = z.infer<typeof ContextBundleSchema>;
export type Finding = z.infer<typeof FindingSchema>;
