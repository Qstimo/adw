import { describe, expect, it } from 'vitest';
import { ContextArtifactSchema, ContextBundleSchema, FindingSchema, TaskSpecSchema, CheckResultSchema, CapabilityManifestSchema, AgentEventSchema, IpcRequestSchema, IpcResponseSchema, PatchAcceptanceSchema } from '../src/index.js';
const artifact = { id: 'art_01', projectId: 'proj_01', kind: 'decision', contentRef: 'sha256:abc', baseCommit: 'a'.repeat(40), sourcePaths: ['src/a.ts'], sourceHashes: { 'src/a.ts': 'b'.repeat(64) }, producerAgent: 'codex', confidence: 'verified', createdAt: '2026-10-31T00:00:00Z', visibility: 'project', tokenEstimate: 120 };
const task = { id: 'task_01', projectId: 'proj_01', intent: 'Add a feature', acceptance: ['Unit passes'], outOfScope: [], baseBranch: 'main', baseCommit: 'a'.repeat(40), status: 'draft' };
describe('snapshot contracts', () => {
 it('accepts provenance and rejects absent SHA, invalid hash and missing source hash', () => {
  expect(ContextArtifactSchema.parse(artifact).confidence).toBe('verified');
  for (const change of [{ baseCommit: undefined }, { baseCommit: 'main' }, { sourceHashes: {} }, { sourceHashes: { 'src/a.ts': 'invalid' } }, { tokenEstimate: -1 }]) {
   expect(ContextArtifactSchema.safeParse({ ...artifact, ...change }).success).toBe(false);
  }
 });
 it('keeps required acceptance and snapshot in the bundle', () => {
  const bundle = { taskId: 'task_01', targetAgent: 'codex', baseCommit: artifact.baseCommit, acceptance: task.acceptance, selectedArtifacts: ['art_01'], sourceRefs: ['src/a.ts'], tokenBudget: 1000, generatedAt: artifact.createdAt };
  expect(ContextBundleSchema.parse(bundle).acceptance).toEqual(task.acceptance);
  expect(ContextBundleSchema.safeParse({ ...bundle, tokenBudget: 0 }).success).toBe(false);
 });
 it('rejects verified findings without evidence', () => {
  const finding = { claim: 'Test passes', evidenceRefs: ['log:1'], affectedPaths: [], verificationStatus: 'verified' };
  expect(FindingSchema.safeParse(finding).success).toBe(true);
  expect(FindingSchema.safeParse({ ...finding, evidenceRefs: [] }).success).toBe(false);
 });
});
it('validates task status, SHA and nonempty acceptance', () => {
 expect(TaskSpecSchema.parse(task).status).toBe('draft');
 for (const change of [{ acceptance: [] }, { status: 'green' }, { baseCommit: '' }]) expect(TaskSpecSchema.safeParse({ ...task, ...change }).success).toBe(false);
});
it('retains red check results and requires notVerified for unexecuted checks', () => {
 const check = { name: 'unit', command: 'pnpm test', exitCode: 1, durationMs: 12, environmentFingerprint: 'env:1', artifactRefs: ['log:1'], blocking: true };
 expect(CheckResultSchema.parse(check).exitCode).toBe(1);
 expect(CheckResultSchema.safeParse({ ...check, exitCode: null }).success).toBe(false);
 expect(CheckResultSchema.parse({ ...check, exitCode: null, notVerified: true }).notVerified).toBe(true);
});
it('preserves unknown capabilities instead of claiming support', () => {
 const manifest = { agentId: 'codex', execution: { headless: 'unknown', cwd: 'supported' }, session: { resume: 'unknown', sessionId: 'unknown' }, output: { format: 'unknown', finalStatus: 'unknown', errors: 'unknown' }, tools: { mcp: 'unknown', permissions: 'unknown', sandbox: 'unknown' }, usage: { tokens: 'unknown', cost: 'unknown', limits: 'unknown' }, control: { cancel: 'supported', timeout: 'supported', processTreeCleanup: 'unknown' } };
 expect(CapabilityManifestSchema.parse(manifest).execution.headless).toBe('unknown');
});
it('validates event payload by discriminant', () => {
 const event = { sessionId: 'session_1', at: artifact.createdAt, type: 'failed', reason: 'timeout' };
 expect(AgentEventSchema.safeParse(event).success).toBe(true);
 expect(AgentEventSchema.safeParse({ ...event, reason: undefined }).success).toBe(false);
});
it('validates method parameters and exclusive IPC success/error payloads', () => {
 expect(IpcRequestSchema.safeParse({ method: 'core.health', id: '1', params: {} }).success).toBe(true);
 expect(IpcRequestSchema.safeParse({ method: 'core.health', id: '1', params: { arbitrary: true } }).success).toBe(false);
 const response = { method: 'core.health', id: '1', ok: true, result: { status: 'ok' } };
 expect(IpcResponseSchema.safeParse(response).success).toBe(true);
 expect(IpcResponseSchema.safeParse({ ...response, error: { code: 'x', message: 'x' } }).success).toBe(false);
});
it('limits acceptance artifacts to local acceptance branches', () => {
 const result = { taskId: 'task_01', status: 'accepted', branch: 'adw/accept/task_01', commit: artifact.baseCommit };
 expect(PatchAcceptanceSchema.safeParse(result).success).toBe(true);
 expect(PatchAcceptanceSchema.safeParse({ ...result, branch: 'main' }).success).toBe(false);
});

it.each(['constructor','toString','__proto__'])('requires an own source hash for %s', path => {
 expect(ContextArtifactSchema.safeParse({...artifact,sourcePaths:[path],sourceHashes:{}}).success).toBe(false);
});
it.each(['constructor','toString','__proto__'])('accepts an own valid hash for %s without prototype mutation', path => {
 const result=ContextArtifactSchema.parse({...artifact,sourcePaths:[path],sourceHashes:Object.fromEntries([[path,'b'.repeat(64)]])});
 expect(Object.hasOwn(result.sourceHashes,path)).toBe(true);
 expect(Object.getPrototypeOf(result.sourceHashes)).toBe(Object.prototype);
 expect(result.sourceHashes[path]).toBe('b'.repeat(64));
});
