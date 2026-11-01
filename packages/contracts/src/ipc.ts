import { z } from 'zod';
import { NonEmptyStringSchema } from './ids.js';
// Concrete method schemas are supplied by each service as it is introduced.
export function createIpcSchemas<P extends z.ZodTypeAny, R extends z.ZodTypeAny>(method: string, params: P, result: R) {
 const request = z.object({ method: z.literal(method), id: NonEmptyStringSchema, params }).strict();
 const response = z.discriminatedUnion('ok', [
  z.object({ method: z.literal(method), id: NonEmptyStringSchema, ok: z.literal(true), result }).strict(),
  z.object({ method: z.literal(method), id: NonEmptyStringSchema, ok: z.literal(false), error: z.object({ code: NonEmptyStringSchema, message: NonEmptyStringSchema }).strict() }).strict()
 ]);
 return { request, response };
}
export const { request: IpcRequestSchema, response: IpcResponseSchema } = createIpcSchemas('core.health', z.object({}).strict(), z.object({ status: z.literal('ok') }).strict());
export type IpcRequest = z.infer<typeof IpcRequestSchema>;
export type IpcResponse = z.infer<typeof IpcResponseSchema>;
