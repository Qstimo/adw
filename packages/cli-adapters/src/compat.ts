import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { CapabilityManifestSchema } from '@adw/contracts';
import type { AgentId } from './types.js';

const ProfileSchema = z.object({
  agentId: z.enum(['codex', 'claude-code']), version: z.string().nullable(),
  protocol: z.enum(['unknown', 'codex-jsonl-v1', 'claude-stream-json-v1']),
  verifiedBy: z.string(), sources: z.array(z.string().url()),
  help: z.object({ start: z.array(z.string()), resume: z.array(z.string()), requiredStart: z.array(z.string()), requiredResume: z.array(z.string()), review: z.array(z.string()).optional(), requiredReview: z.array(z.string()).optional() }).strict(),
  arguments: z.object({ start: z.array(z.string()), resume: z.array(z.string()), review: z.array(z.string()).optional() }).strict(),
  capabilities: CapabilityManifestSchema,
}).strict();
export type CompatibilityProfile = z.infer<typeof ProfileSchema>;

export async function loadCompatibility(id: AgentId, version: string): Promise<CompatibilityProfile> {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid CLI version');
  let data: string;
  try { data = await readFile(new URL(`../compat/${id}/${version}.json`, import.meta.url), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    data = await readFile(new URL(`../compat/${id}/default.json`, import.meta.url), 'utf8');
  }
  const profile = ProfileSchema.parse(JSON.parse(data));
  if (profile.agentId !== id || profile.capabilities.agentId !== id || (profile.version !== null && profile.version !== version)) throw new Error('Compatibility profile identity mismatch');
  return profile;
}
