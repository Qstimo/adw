import { z } from 'zod';
import { WebVerificationSchema } from './web-verification.js';
import { NonEmptyStringSchema } from './ids.js';
export const AdwConfigSchema = z.object({
 dataDir: NonEmptyStringSchema, agents: z.array(NonEmptyStringSchema).min(1),
 verifier: z.object({ commands: z.record(NonEmptyStringSchema, NonEmptyStringSchema).refine(value => Object.keys(value).length > 0, 'At least one check is required'), web:WebVerificationSchema.optional() }).strict(),
 privacyMode: z.enum(['local-only','cli-subscription','api-provider'])
}).strict();
export type AdwConfig = z.infer<typeof AdwConfigSchema>;
