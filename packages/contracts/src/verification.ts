import { z } from 'zod';
import { AcceptanceCoverageSchema } from './web-verification.js';
import { CommitSchema, NonEmptyStringSchema } from './ids.js';
export const EvidenceRefSchema = z.object({ ref: NonEmptyStringSchema, mediaType: NonEmptyStringSchema, description: NonEmptyStringSchema.optional() }).strict();
export const CheckResultSchema = z.object({ name: NonEmptyStringSchema, command: NonEmptyStringSchema, exitCode: z.number().int().nullable(), durationMs: z.number().nonnegative(), environmentFingerprint: NonEmptyStringSchema, artifactRefs: z.array(NonEmptyStringSchema), coverage: z.string().optional(), kind:z.enum(['command','environment_health','api_smoke','playwright_e2e','acceptance']).optional(), evidenceManifestRef:z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), acceptanceCoverage:z.array(AcceptanceCoverageSchema).optional(), notVerified: z.boolean().default(false), blocking: z.boolean(), baseCommit: CommitSchema.optional() }).strict().superRefine((value, ctx) => {
 if (value.exitCode === null && !value.notVerified) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['exitCode'], message: 'Unexecuted check must be marked notVerified' });
});
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
