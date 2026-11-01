import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectIndexer } from '../src/index.js';
import type { IndexBuildInput } from '../src/index.js';
export function fixture(files:Record<string,string|Buffer>){
 const root=mkdtempSync(join(tmpdir(),'adw-context-')),repo=join(root,'repo');mkdirSync(repo);
 for(const [path,content] of Object.entries(files)){mkdirSync(dirname(join(repo,path)),{recursive:true});writeFileSync(join(repo,path),content);}
 return {root,repo,dbPath:join(root,'index.sqlite')};
}
export function build(f:ReturnType<typeof fixture>,options:Partial<IndexBuildInput>={}){
 return ProjectIndexer.build({projectId:'proj_test',repoPath:f.repo,baseCommit:'a'.repeat(40),dbPath:f.dbPath,...options});
}
