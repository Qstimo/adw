import { z } from 'zod';
import { CommitSchema, HashSchema, ProjectIdSchema, TimestampSchema } from './ids.js';

export const IndexLimitsSchema = z.object({
  maxFiles: z.number().int().min(1).max(100_000),
  maxFileBytes: z.number().int().min(1).max(16 * 1024 * 1024),
  maxTotalBytes: z.number().int().min(1).max(256 * 1024 * 1024),
  timeoutMs: z.number().int().min(1).max(60_000),
  maxListBytes: z.number().int().min(1).max(8 * 1024 * 1024),
  maxFacts: z.number().int().min(1).max(500_000),
}).strict();
export const IndexWarningSchema = z.object({
  code: z.enum(['max_files','max_file_bytes','max_total_bytes','binary','symlink','read_error','unstable_file','parser_error','manifest_error','invalid_path']),
  message: z.string().min(1), path: z.string().optional(), count: z.number().int().positive().optional(),
}).strict();
export const IndexedFileSchema = z.object({
  path: z.string().min(1), contentHash: HashSchema, size: z.number().int().nonnegative(),
  language: z.enum(['typescript','tsx','javascript','jsx','json','text']),
  symbolStatus: z.enum(['parsed','partial','unsupported']), updatedAt: TimestampSchema,
}).strict();
export const IndexedSymbolSchema = z.object({
  path: z.string().min(1), name: z.string().min(1),
  kind: z.enum(['function','class','interface','type','enum','namespace','variable','method','property']),
  startLine: z.number().int().positive(), endLine: z.number().int().positive(),
}).strict();
export const IndexedImportSchema = z.object({
  path: z.string().min(1), specifier: z.string().min(1), kind: z.enum(['import','export','require','dynamic']),
  startLine: z.number().int().positive(), resolvedPath: z.string().optional(),
}).strict();
export const IndexManifestSchema = z.object({
  path: z.string().min(1), kind: z.enum(['package','tsconfig']), data: z.unknown(),
}).strict();
export const DiscoveredCommandSchema = z.object({
  name: z.string().min(1), command: z.string().min(1), cwd: z.string().min(1), manifestPath: z.string().min(1),
}).strict();
export const ProjectMapSchema = z.object({
  projectId: ProjectIdSchema, repoPath: z.string().min(1), baseCommit: CommitSchema,
  snapshotId: z.string().regex(/^idx_[a-f0-9]{64}$/), createdAt: TimestampSchema,
  parser: z.object({name:z.literal('typescript'),version:z.string().min(1)}).strict(),
  limits: IndexLimitsSchema, files: z.array(IndexedFileSchema), symbols: z.array(IndexedSymbolSchema),
  imports: z.array(IndexedImportSchema), manifests: z.array(IndexManifestSchema), testCommands: z.array(DiscoveredCommandSchema),
  warnings: z.array(IndexWarningSchema), complete: z.boolean(),
}).strict();
export type IndexLimits = z.infer<typeof IndexLimitsSchema>;
export type IndexWarning = z.infer<typeof IndexWarningSchema>;
export type IndexedFile = z.infer<typeof IndexedFileSchema>;
export type IndexedSymbol = z.infer<typeof IndexedSymbolSchema>;
export type IndexedImport = z.infer<typeof IndexedImportSchema>;
export type IndexManifest = z.infer<typeof IndexManifestSchema>;
export type DiscoveredCommand = z.infer<typeof DiscoveredCommandSchema>;
export type ProjectMap = z.infer<typeof ProjectMapSchema>;
