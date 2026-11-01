import type { IndexLimits, IndexWarning } from '@adw/contracts';
export interface IndexBuildInput {
  projectId: string; repoPath: string; baseCommit: string; dbPath?: string; limits?: Partial<IndexLimits>;
}
export interface IndexStats { readFiles: number; analyzedFiles: number; reusedFiles: number; skippedFiles: number; totalBytes: number }
export interface IndexUpdate {
  snapshotId: string; previousSnapshotId?: string; baseChanged: boolean;
  changedPaths: string[]; deletedPaths: string[]; staleArtifactHints: string[];
  warnings: IndexWarning[]; stats: IndexStats;
}
export interface SearchInput { query: string; scope?: string; limit?: number; engine?: 'fts'|'ripgrep'; snapshotId?: string }
export interface SearchHit { path: string; contentHash: string; lineNumber: number; line: string; source: 'fts'|'ripgrep' }
export interface SearchResult { snapshotId: string; baseCommit: string; complete:boolean; warnings:IndexWarning[]; hits: SearchHit[] }
