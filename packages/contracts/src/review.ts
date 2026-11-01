import { z } from 'zod';
import { TaskIdSchema, NonEmptyStringSchema } from './ids.js';
import { PatchSnapshotSchema } from './git.js';
export const ReviewCategorySchema = z.enum(['code', 'security', 'visual']);
const ref = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const path = z.string().min(1).max(4096).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && !value.split('/').some(part => part === '..' || part === '.' || !part), 'Expected a relative POSIX file path');
export const ReviewRemarkSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), category: ReviewCategorySchema, severity: z.enum(['blocking', 'advisory']), message: z.string().min(1).max(64000).refine(value => !!value.trim()), path: path.optional(), startLine: z.number().int().min(1).max(1000000).optional(), endLine: z.number().int().min(1).max(1000000).optional(), evidenceRefs: z.array(ref).max(1000), verificationStatus: z.enum(['inferred', 'unverified']).default('inferred') }).strict().superRefine((value, ctx) => {
    if ((value.startLine !== undefined || value.endLine !== undefined) && !value.path)
        ctx.addIssue({ code: 'custom', message: 'Line ranges require a path' });
    if (value.endLine !== undefined && (value.startLine === undefined || value.endLine < value.startLine))
        ctx.addIssue({ code: 'custom', message: 'Invalid line range' });
});
export const ReviewResponseSchema = z.object({ category: z.enum(['code', 'security']), remarks: z.array(ReviewRemarkSchema).max(100) }).strict().superRefine((value, ctx) => {
    if (value.remarks.some(remark => remark.category !== value.category))
        ctx.addIssue({ code: 'custom', message: 'Remark category differs from review pass' });
    if (new Set(value.remarks.map(remark => remark.id)).size !== value.remarks.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate remark ID' });
});
export const ReviewerSessionSchema = z.object({ agentId: NonEmptyStringSchema, sessionId: NonEmptyStringSchema, providerSessionId: NonEmptyStringSchema.optional(), category: z.enum(['code', 'security']) }).strict();
export const ReviewVerdictSchema = z.object({ id: z.string().startsWith('review_'), taskId: TaskIdSchema, snapshot: PatchSnapshotSchema, snapshotValid: z.boolean(), remarks: z.array(ReviewRemarkSchema).max(200), blockingCount: z.number().int().nonnegative(), status: z.enum(['approved', 'changes_requested', 'inconclusive']), completedCategories: z.array(z.enum(['code', 'security'])).max(2), reviewerSessions: z.array(ReviewerSessionSchema).max(2), evidenceRefs: z.array(ref).max(1000), reason: z.string().optional() }).strict().superRefine((value, ctx) => {
    const blocking = value.remarks.filter(remark => remark.severity === 'blocking').length;
    if (value.snapshot.taskId !== value.taskId || value.blockingCount !== blocking)
        ctx.addIssue({ code: 'custom', message: 'Inconsistent verdict task/count' });
    if (new Set(value.remarks.map(remark => remark.id)).size !== value.remarks.length || new Set(value.completedCategories).size !== value.completedCategories.length)
        ctx.addIssue({ code: 'custom', message: 'Duplicate verdict IDs/categories' });
    const sessions = value.reviewerSessions;
    if (new Set(sessions.map(session => session.sessionId)).size !== sessions.length || new Set(sessions.filter(session => session.providerSessionId).map(session => session.agentId + ':' + session.providerSessionId)).size !== sessions.filter(session => session.providerSessionId).length)
        ctx.addIssue({ code: 'custom', message: 'Review sessions must be independent' });
    if (value.status === 'approved' && (blocking > 0 || !value.snapshotValid || !['code', 'security'].every(category => value.completedCategories.includes(category as 'code' | 'security') && sessions.some(session => session.category === category)) || !value.evidenceRefs.length))
        ctx.addIssue({ code: 'custom', message: 'Approved review requires complete independent passes and evidence' });
    if (value.status === 'changes_requested' && blocking === 0)
        ctx.addIssue({ code: 'custom', message: 'Changes requested requires a blocking remark' });
    if (value.status === 'inconclusive' && blocking > 0)
        ctx.addIssue({ code: 'custom', message: 'Blocking remarks require changes requested' });
});
export type ReviewRemark = z.infer<typeof ReviewRemarkSchema>;
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type ReviewerSession = z.infer<typeof ReviewerSessionSchema>;
