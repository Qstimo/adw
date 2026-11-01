import { z } from 'zod';
import { NonEmptyStringSchema, SessionIdSchema, TimestampSchema } from './ids.js';
const support = z.enum(['supported','unsupported','unknown']);
export const CapabilityManifestSchema = z.object({
 agentId: NonEmptyStringSchema,
 execution: z.object({ headless: support, cwd: support }).strict(),
 session: z.object({ resume: support, sessionId: support }).strict(),
 output: z.object({ format: z.enum(['json','jsonl','text','unknown']), finalStatus: support, errors: support }).strict(),
 tools: z.object({ mcp: support, permissions: support, sandbox: support }).strict(),
 usage: z.object({ tokens: support, cost: support, limits: support }).strict(),
 control: z.object({ cancel: support, timeout: support, processTreeCleanup: support }).strict()
}).strict();
export const AgentFailureCodeSchema = z.enum(['invalid_input','discovery_failed','unsupported_version','capability_mismatch','spawn_error','provider_error','permission_denied','protocol_error','exit_code','signal','timeout','cancelled','output_limit','queue_limit','io_error']);
export type AgentFailureCode = z.infer<typeof AgentFailureCodeSchema>;
const common = { sessionId: SessionIdSchema, at: TimestampSchema, providerSessionId: NonEmptyStringSchema.optional() };
export const AgentEventSchema = z.discriminatedUnion('type', [
 z.object({ ...common, type: z.literal('session_started'), agentId: NonEmptyStringSchema }).strict(),
 z.object({ ...common, type: z.literal('log'), stream: z.enum(['stdout','stderr']), message: z.string() }).strict(),
 z.object({ ...common, type: z.literal('tool_call'), callId: NonEmptyStringSchema, name: NonEmptyStringSchema, input: z.unknown() }).strict(),
 z.object({ ...common, type: z.literal('tool_result'), callId: NonEmptyStringSchema, output: z.unknown() }).strict(),
 z.object({ ...common, type: z.literal('usage'), tokens: z.number().int().nonnegative().optional(), cost: z.number().nonnegative().optional(), inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), cachedInputTokens: z.number().int().nonnegative().optional(), cacheCreationInputTokens: z.number().int().nonnegative().optional() }).strict(),
 z.object({ ...common, type: z.literal('completed'), summary: z.string() }).strict(),
 z.object({ ...common, type: z.literal('failed'), reason: NonEmptyStringSchema, code: AgentFailureCodeSchema.optional() }).strict(),
 z.object({ ...common, type: z.literal('heartbeat') }).strict()
]);
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
