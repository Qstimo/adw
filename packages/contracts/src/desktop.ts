import {z} from 'zod';
import {TaskSpecSchema,TaskStatusSchema} from './task.js';
import {ProjectIdSchema,TaskIdSchema,HashSchema,ArtifactIdSchema} from './ids.js';
import {ReviewVerdictSchema} from './review.js';
import {PatchAcceptanceSchema} from './git.js';
import {WebVerificationSchema,AcceptanceCoverageSchema} from './web-verification.js';
const text=z.string().max(16000).refine(value=>!!value.trim());
const criteria=z.array(z.string().max(4000).refine(value=>!!value.trim())).min(1).max(100);
export const DesktopPolicySchema=z.object({checks:z.array(z.object({name:z.string().min(1).max(100),command:z.string().min(1).max(8000),blocking:z.boolean(),timeoutMs:z.number().int().positive().max(2147483647).optional()}).strict()).min(1).max(20),limits:z.object({wallTimeMs:z.number().int().min(1000).max(3600000),sessionTimeoutMs:z.number().int().min(1000).max(3600000),bundleTokens:z.number().int().min(100).max(1000000),maxTokens:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),maxCost:z.number().positive().finite().optional(),maxFixCycles:z.number().int().min(0).max(3)}).strict(),web:WebVerificationSchema.optional(),privacyMode:z.enum(['local-only','cli-subscription','api-provider'])}).strict().refine(value=>value.checks.some(check=>check.blocking),'At least one required check is needed');
export type DesktopPolicy=z.infer<typeof DesktopPolicySchema>;
export const DesktopTaskSpecSchema=TaskSpecSchema.extend({intent:text,acceptance:criteria,outOfScope:z.array(z.string().max(4000)).max(100)});
export const DesktopTaskSchema=z.object({spec:DesktopTaskSpecSchema,specHash:HashSchema,policy:DesktopPolicySchema,policyHash:HashSchema,run:z.object({id:z.string(),state:z.string(),active:z.boolean(),startedAt:z.string(),nodes:z.array(z.object({id:z.string(),instruction:z.string(),dependsOn:z.array(z.string()),status:z.string()}).strict()),reason:z.string().optional(),review:ReviewVerdictSchema.optional(),worktreePath:z.string().optional(),tokens:z.number().nonnegative().nullable(),cost:z.number().nonnegative().nullable()}).strict().nullable()}).strict();
export type DesktopTask=z.infer<typeof DesktopTaskSchema>;
export const DesktopProjectSchema=z.object({id:ProjectIdSchema,path:z.string(),baseBranch:z.string(),branches:z.array(z.string()).max(1000),head:z.string(),dirty:z.boolean(),worktrees:z.array(z.object({path:z.string(),head:z.string(),branch:z.string().optional()}).strict()).max(1000),privacyMode:z.enum(['local-only','cli-subscription','api-provider']),policy:DesktopPolicySchema,tasks:z.array(z.object({id:TaskIdSchema,intent:z.string(),status:TaskStatusSchema}).strict()).max(100)}).strict();
export type DesktopProject=z.infer<typeof DesktopProjectSchema>;
export const DesktopCheckSchema=z.object({id:z.string(),name:z.string(),command:z.string(),exitCode:z.number().nullable(),durationMs:z.number(),notVerified:z.boolean(),blocking:z.boolean(),baseCommit:z.string().nullable(),coverage:z.array(AcceptanceCoverageSchema),artifacts:z.array(z.object({ref:z.string(),mediaType:z.string(),role:z.string()}).strict())}).strict();
export type DesktopCheck=z.infer<typeof DesktopCheckSchema>;
export const DesktopContextSchema=z.object({snapshotId:z.string(),baseCommit:z.string(),complete:z.boolean(),fileCount:z.number(),symbolCount:z.number(),warnings:z.array(z.string()),files:z.array(z.object({path:z.string(),hash:z.string()}).strict()),decisions:z.array(z.object({id:ArtifactIdSchema,kind:z.string(),confidence:z.string(),baseCommit:z.string(),sourcePaths:z.array(z.string()),fresh:z.boolean(),reasons:z.array(z.string())}).strict()),cacheHits:z.number(),truncated:z.boolean()}).strict();
export type DesktopContext=z.infer<typeof DesktopContextSchema>;
const task=z.object({taskId:TaskIdSchema}).strict();
const draftFields={projectId:ProjectIdSchema,baseBranch:z.string().min(1).max(200),intent:text,acceptance:criteria,outOfScope:z.array(z.string().max(4000)).max(100),checks:DesktopPolicySchema.innerType().shape.checks,limits:DesktopPolicySchema.innerType().shape.limits};
const methods={
 'core.health':{params:z.object({}).strict(),result:z.object({status:z.literal('ok')}).strict()},
 'project.pick':{params:z.object({}).strict(),result:DesktopProjectSchema.nullable()},
 'project.open':{params:z.object({path:z.string().min(1).max(4096)}).strict(),result:DesktopProjectSchema},
 'project.getStatus':{params:z.object({projectId:ProjectIdSchema}).strict(),result:DesktopProjectSchema},
 'project.setPrivacy':{params:z.object({projectId:ProjectIdSchema,privacyMode:z.enum(['local-only','cli-subscription','api-provider'])}).strict(),result:DesktopProjectSchema},
 'task.createDraft':{params:z.object(draftFields).strict(),result:DesktopTaskSchema},
 'task.updateDraft':{params:z.object({...draftFields,taskId:TaskIdSchema}).strict(),result:DesktopTaskSchema},
 'task.confirmSpec':{params:z.object({taskId:TaskIdSchema,expectedSpecHash:HashSchema,expectedPolicyHash:HashSchema}).strict(),result:DesktopTaskSchema},
 'task.get':{params:task,result:DesktopTaskSchema},
 'task.start':{params:task,result:z.object({runId:z.string()}).strict()},
 'task.cancel':{params:z.object({taskId:TaskIdSchema,runId:z.string()}).strict(),result:z.object({cancelled:z.boolean()}).strict()},
 'task.subscribeEvents':{params:z.object({taskId:TaskIdSchema,after:z.number().int().nonnegative().default(0)}).strict(),result:z.object({cursor:z.number(),events:z.array(z.object({cursor:z.number(),at:z.string(),action:z.string(),payload:z.string(),truncated:z.boolean()}).strict()).max(100)}).strict()},
 'context.getProjectMap':{params:task,result:DesktopContextSchema},
 'context.getDecisions':{params:task,result:DesktopContextSchema.shape.decisions},
 'context.getArtifact':{params:z.object({taskId:TaskIdSchema,artifactId:ArtifactIdSchema}).strict(),result:z.object({content:z.string(),truncated:z.boolean(),fresh:z.boolean()}).strict()},
 'verification.getMatrix':{params:task,result:z.array(DesktopCheckSchema).max(2000)},
 'evidence.read':{params:z.object({taskId:TaskIdSchema,ref:z.string().regex(/^sha256:[a-f0-9]{64}$/),offset:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),length:z.number().int().min(1).max(65536)}).strict(),result:z.object({data:z.string(),totalBytes:z.number(),mediaType:z.string()}).strict()},
 'review.getVerdict':{params:task,result:z.object({verdict:ReviewVerdictSchema.nullable(),diff:z.string(),truncated:z.boolean(),changedTests:z.array(z.string())}).strict()},
 'review.acceptPatch':{params:z.object({taskId:TaskIdSchema,reviewId:z.string().startsWith('review_')}).strict(),result:PatchAcceptanceSchema},
 'review.rejectPatch':{params:z.object({taskId:TaskIdSchema,reason:text}).strict(),result:PatchAcceptanceSchema},
} as const;
export const DesktopMethods=methods;
export type DesktopMethod=keyof typeof methods;
export type DesktopParams<M extends DesktopMethod>=z.input<(typeof methods)[M]['params']>;
export type DesktopResult<M extends DesktopMethod>=z.output<(typeof methods)[M]['result']>;
export interface DesktopClient {invoke<M extends DesktopMethod>(method:M,params:DesktopParams<M>):Promise<DesktopResult<M>>}
export const DesktopEnvelopeSchema=z.object({id:z.string().uuid(),method:z.string().max(100),params:z.unknown()}).strict();
export const DesktopResponseSchema=z.discriminatedUnion('ok',[z.object({id:z.string().uuid(),ok:z.literal(true),result:z.unknown()}).strict(),z.object({id:z.string().uuid(),ok:z.literal(false),error:z.object({code:z.string(),message:z.string()}).strict()}).strict()]);
export const DesktopHumanMethods=new Set<DesktopMethod>(['task.confirmSpec','review.acceptPatch','review.rejectPatch']);
export const DesktopRendererMethods=Object.keys(methods).filter(method=>method!=='project.open'&&method!=='core.health') as DesktopMethod[];
