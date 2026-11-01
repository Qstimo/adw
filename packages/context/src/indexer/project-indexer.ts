import { mkdirSync, mkdtempSync, realpathSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, relative, isAbsolute, join, sep } from 'node:path';
import type Database from 'better-sqlite3';
import { CommitSchema, ProjectIdSchema, ProjectMapSchema, IndexLimitsSchema, type IndexLimits, type IndexWarning, type IndexedFile, type IndexedSymbol, type IndexedImport, type IndexManifest, type ProjectMap } from '@adw/contracts';
import { openIndexDb } from '../db/client.js';
import { contentHash, readSource } from './hash.js';
import { walkFiles, safeRelativePath, normalizeScope, inScope } from './walk.js';
import { extractSymbols, languageFor, PARSER_VERSION, resolveImport } from './symbols.js';
import { extractManifest, discoverCommands } from './manifests.js';
import { searchFts, type FileDocument } from './fts.js';
import { searchWithRipgrep } from '../search/ripgrep.js';
import type { IndexBuildInput, IndexStats, IndexUpdate, SearchInput, SearchResult } from '../types.js';

const DEFAULT_LIMITS:IndexLimits={maxFiles:10_000,maxFileBytes:512*1024,maxTotalBytes:32*1024*1024,timeoutMs:20_000,maxListBytes:2*1024*1024,maxFacts:100_000};
interface SnapshotRow {id:string;project_id:string;base_commit:string;parser_version:string;limits_json:string;warnings_json:string;stats_json:string;created_at:string}
interface FileRow {path:string;content_hash:string;size:number;language:IndexedFile['language'];symbol_status:IndexedFile['symbolStatus'];updated_at:string;warnings_json:string}
interface AnalyzedFile {path:string;hash:string;size:number;text:string;language:IndexedFile['language'];status:IndexedFile['symbolStatus'];warnings:IndexWarning[];symbols:IndexedSymbol[];imports:IndexedImport[];manifest?:IndexManifest;reuse:boolean;updatedAt:string}
function inside(parent:string,child:string){const path=relative(parent,child);return !path||(!path.startsWith('..'+sep)&&path!=='..'&&!isAbsolute(path));}

export class ProjectIndexer {
 readonly projectId:string;readonly repoPath:string;readonly dbPath:string;readonly limits:Readonly<IndexLimits>;
 private db:Database.Database;private temporaryRoot?:string;private closed=false;private busy=false;private snapshotId='';
 private constructor(input:IndexBuildInput){
  this.projectId=ProjectIdSchema.parse(input.projectId);CommitSchema.parse(input.baseCommit);
  this.repoPath=realpathSync(input.repoPath);if(!statSync(this.repoPath).isDirectory())throw new Error('Repository path must be a directory');this.limits=Object.freeze(IndexLimitsSchema.parse({...DEFAULT_LIMITS,...input.limits}));
  if(input.dbPath===':memory:')this.dbPath=':memory:';
  else {
   let requested:string;
   if(input.dbPath)requested=resolve(input.dbPath);else{this.temporaryRoot=mkdtempSync(join(tmpdir(),'adw-index-'));requested=join(this.temporaryRoot,'index.sqlite');}
   if(inside(this.repoPath,requested)){if(this.temporaryRoot)rmSync(this.temporaryRoot,{recursive:true,force:true});throw new Error('Index database must be outside the repository');}
   mkdirSync(dirname(requested),{recursive:true,mode:0o700});
   this.dbPath=existsSync(requested)?realpathSync(requested):join(realpathSync(dirname(requested)),basename(requested));
   if(inside(this.repoPath,this.dbPath))throw new Error('Index database resolves inside the repository');
  }
  try{this.db=openIndexDb(this.dbPath);}catch(error){if(this.temporaryRoot)rmSync(this.temporaryRoot,{recursive:true,force:true});throw error;}
 }
 static async build(input:IndexBuildInput):Promise<ProjectIndexer>{
  const index=new ProjectIndexer(input);
  try{await index.refresh(input.baseCommit);return index;}catch(error){index.close();throw error;}
 }
 private assertOpen(){if(this.closed)throw new Error('Project index is closed');}
 close():void{if(this.closed)return;if(this.busy)throw new Error('Cannot close during an index update');this.closed=true;this.db.close();if(this.temporaryRoot)rmSync(this.temporaryRoot,{recursive:true,force:true});}
 private snapshot(id=this.snapshotId):SnapshotRow {
  this.assertOpen();const row=this.db.prepare('SELECT s.* FROM index_snapshots s JOIN index_projects p ON p.project_id=s.project_id WHERE s.id=? AND s.project_id=? AND p.repo_path=?').get(id,this.projectId,this.repoPath) as SnapshotRow|undefined;
  if(!row)throw new Error('Snapshot not found in this project');return row;
 }
 private files(id:string):FileRow[]{return this.db.prepare('SELECT path,content_hash,size,language,symbol_status,updated_at,warnings_json FROM indexed_files WHERE snapshot_id=? ORDER BY path').all(id) as FileRow[];}
 async reindexChanged(input:{baseCommit?:string}={}):Promise<IndexUpdate>{return this.refresh(input.baseCommit??this.snapshot().base_commit);}
 private async refresh(baseCommit:string):Promise<IndexUpdate>{
  this.assertOpen();CommitSchema.parse(baseCommit);if(this.busy)throw new Error('Index update already running');this.busy=true;
  try {
   const project=this.db.prepare('SELECT repo_path,latest_snapshot_id FROM index_projects WHERE project_id=?').get(this.projectId) as {repo_path:string;latest_snapshot_id:string|null}|undefined;
   if(project&&project.repo_path!==this.repoPath)throw new Error('Project ID belongs to another repository');
   const previousId=this.snapshotId||project?.latest_snapshot_id||undefined;
   const previous=previousId?this.snapshot(previousId):undefined;
   const previousFiles=previousId?this.files(previousId):[],oldFiles=new Map(previousFiles.map(file=>[file.path,file]));
   const deadline=Date.now()+this.limits.timeoutMs;
   const paths=await walkFiles(this.repoPath,this.limits.maxListBytes,this.limits.timeoutMs);
   const warnings:IndexWarning[]=[];const stats:IndexStats={readFiles:0,analyzedFiles:0,reusedFiles:0,skippedFiles:0,totalBytes:0};
   const entries:AnalyzedFile[]=[];let facts=0;
   if(paths.length>this.limits.maxFiles){stats.skippedFiles=paths.length-this.limits.maxFiles;warnings.push({code:'max_files',message:'Only the first maxFiles paths in sorted order are indexed',count:stats.skippedFiles});}
   for(const path of paths.slice(0,this.limits.maxFiles)){
    if(Date.now()>deadline)throw new Error('Index scan timed out; previous snapshot is unchanged');
    if(!safeRelativePath(path)){stats.skippedFiles++;warnings.push({code:'invalid_path',path,message:'Unsupported repository path'});continue;}
    const read=await readSource(this.repoPath,path,this.limits.maxFileBytes,this.limits.maxTotalBytes-stats.totalBytes);
    if('warning'in read){stats.totalBytes+=read.bytesRead;stats.skippedFiles++;warnings.push(read.warning);continue;}
    stats.readFiles++;stats.totalBytes+=read.size;
    const old=oldFiles.get(path);let reuse=old?.content_hash===read.hash&&previous?.parser_version===PARSER_VERSION;
    let oldFacts=0;
    if(reuse){
     const count=this.db.prepare('SELECT (SELECT count(*) FROM indexed_symbols WHERE snapshot_id=? AND path=?)+(SELECT count(*) FROM indexed_imports WHERE snapshot_id=? AND path=?) AS n').get(previousId,path,previousId,path) as {n:number};oldFacts=count.n;
     const oldWarnings=JSON.parse(old!.warnings_json) as IndexWarning[];
     reuse=oldFacts<=this.limits.maxFacts-facts&&!oldWarnings.some(w=>w.message.includes('budget exhausted')||w.message.includes('resource limit'))&&JSON.parse(previous!.limits_json).maxFacts===this.limits.maxFacts;
    }
    let symbols:IndexedSymbol[]=[],imports:IndexedImport[]=[],manifest:IndexManifest|undefined,fileWarnings:IndexWarning[]=[],status:IndexedFile['symbolStatus'];
    if(reuse){stats.reusedFiles++;fileWarnings=JSON.parse(old!.warnings_json);status=old!.symbol_status;
     // Count reused facts against the same global budget as newly parsed files.
     facts+=oldFacts;
    } else {
     stats.analyzedFiles++;const parsed=extractSymbols(read.text,path,Math.min(5000,Math.max(0,this.limits.maxFacts-facts)));symbols=parsed.symbols;imports=parsed.imports;status=parsed.status;facts+=symbols.length+imports.length;
     const extracted=extractManifest(read.text,path);manifest=extracted.manifest;fileWarnings=[...parsed.warnings,...extracted.warnings];
    }
    warnings.push(...fileWarnings);
    entries.push({path,hash:read.hash,size:read.size,text:read.text,language:languageFor(path),status,warnings:fileWarnings,symbols,imports,manifest,reuse,updatedAt:reuse?old!.updated_at:new Date(Math.max(Date.now(),old?Date.parse(old.updated_at)+1:0)).toISOString()});
   }
   if(Date.now()>deadline)throw new Error('Index scan timed out; previous snapshot is unchanged');
   const compactWarnings=warnings.length<=200?warnings:[...warnings.slice(0,200),{code:'read_error' as const,message:'Additional warnings omitted from the map',count:warnings.length-200}];
   const id='idx_'+contentHash(JSON.stringify({projectId:this.projectId,repoPath:this.repoPath,baseCommit,parser:PARSER_VERSION,limits:this.limits,files:entries.map(e=>[e.path,e.hash,e.status]),warnings:compactWarnings}));
   const newFiles=new Map(entries.map(entry=>[entry.path,entry.hash]));
   const changedPaths=entries.filter(entry=>oldFiles.get(entry.path)?.content_hash!==entry.hash).map(e=>e.path);
   const deletedPaths=previousFiles.filter(file=>!newFiles.has(file.path)).map(file=>file.path);
   const baseChanged=previous!==undefined&&previous.base_commit!==baseCommit;
   this.db.transaction(()=>{
    const bound=this.db.prepare('SELECT repo_path FROM index_projects WHERE project_id=?').get(this.projectId) as {repo_path:string}|undefined;
    if(bound&&bound.repo_path!==this.repoPath)throw new Error('Project ID belongs to another repository');
    this.db.prepare('INSERT OR IGNORE INTO index_projects (project_id,repo_path) VALUES (?,?)').run(this.projectId,this.repoPath);
    if(!this.db.prepare('SELECT 1 FROM index_snapshots WHERE id=?').get(id)){
     this.db.prepare('INSERT INTO index_snapshots VALUES (?,?,?,?,?,?,?,?)').run(id,this.projectId,baseCommit,PARSER_VERSION,JSON.stringify(this.limits),JSON.stringify(compactWarnings),JSON.stringify(stats),new Date().toISOString());
     for(const entry of entries){
      const inserted=this.db.prepare('INSERT OR IGNORE INTO indexed_contents VALUES (?,?,?)').run(entry.hash,entry.size,entry.text);
      if(inserted.changes)this.db.prepare('INSERT INTO indexed_files_fts (content_hash,content) VALUES (?,?)').run(entry.hash,entry.text);
      else {const stored=this.db.prepare('SELECT content FROM indexed_contents WHERE content_hash=?').get(entry.hash) as {content:string};if(stored.content!==entry.text)throw new Error('Index content hash mismatch');}
      this.db.prepare('INSERT INTO indexed_files VALUES (?,?,?,?,?,?,?,?)').run(id,entry.path,entry.hash,entry.size,entry.language,entry.status,entry.updatedAt,JSON.stringify(entry.warnings));
      if(entry.reuse){
       this.db.prepare('INSERT INTO indexed_symbols SELECT ?,path,name,kind,start_line,end_line FROM indexed_symbols WHERE snapshot_id=? AND path=?').run(id,previousId,entry.path);
       this.db.prepare('INSERT INTO indexed_imports SELECT ?,path,specifier,kind,start_line FROM indexed_imports WHERE snapshot_id=? AND path=?').run(id,previousId,entry.path);
       this.db.prepare('INSERT INTO project_manifests SELECT ?,path,kind,json FROM project_manifests WHERE snapshot_id=? AND path=?').run(id,previousId,entry.path);
      }else{
       for(const s of entry.symbols)this.db.prepare('INSERT INTO indexed_symbols VALUES (?,?,?,?,?,?)').run(id,s.path,s.name,s.kind,s.startLine,s.endLine);
       for(const i of entry.imports)this.db.prepare('INSERT INTO indexed_imports VALUES (?,?,?,?,?)').run(id,i.path,i.specifier,i.kind,i.startLine);
       if(entry.manifest)this.db.prepare('INSERT INTO project_manifests VALUES (?,?,?,?)').run(id,entry.path,entry.manifest.kind,JSON.stringify(entry.manifest.data));
      }
     }
    }
    this.db.prepare('UPDATE index_projects SET latest_snapshot_id=? WHERE project_id=?').run(id,this.projectId);
   }).immediate();
   this.snapshotId=id;
   return {snapshotId:id,previousSnapshotId:previousId,baseChanged,changedPaths,deletedPaths,staleArtifactHints:[...new Set(baseChanged?[...previousFiles.map(f=>f.path),...entries.map(e=>e.path)]:[...changedPaths,...deletedPaths])].sort(),warnings:compactWarnings,stats};
  }finally{this.busy=false;}
 }
 getProjectMap(snapshotId=this.snapshotId):ProjectMap {
  const snapshot=this.snapshot(snapshotId),files=this.files(snapshotId);
  const symbols=(this.db.prepare('SELECT path,name,kind,start_line AS startLine,end_line AS endLine FROM indexed_symbols WHERE snapshot_id=? ORDER BY path,start_line,name').all(snapshotId)) as IndexedSymbol[];
  const imports=this.db.prepare('SELECT path,specifier,kind,start_line AS startLine FROM indexed_imports WHERE snapshot_id=? ORDER BY path,start_line,specifier').all(snapshotId) as IndexedImport[];
  const available=new Set(files.map(f=>f.path));const resolved=imports.map(item=>{const resolvedPath=resolveImport(item.path,item.specifier,available);return {...item,...(resolvedPath?{resolvedPath}:{})};});
  const manifests=(this.db.prepare('SELECT path,kind,json FROM project_manifests WHERE snapshot_id=? ORDER BY path').all(snapshotId) as {path:string;kind:IndexManifest['kind'];json:string}[]).map(row=>({path:row.path,kind:row.kind,data:JSON.parse(row.json)}));
  const warnings=JSON.parse(snapshot.warnings_json) as IndexWarning[];
  return ProjectMapSchema.parse({projectId:this.projectId,repoPath:this.repoPath,baseCommit:snapshot.base_commit,snapshotId,createdAt:snapshot.created_at,parser:{name:'typescript',version:snapshot.parser_version},limits:JSON.parse(snapshot.limits_json),files:files.map(f=>({path:f.path,contentHash:f.content_hash,size:f.size,language:f.language,symbolStatus:f.symbol_status,updatedAt:f.updated_at})),symbols,imports:resolved,manifests,testCommands:discoverCommands(manifests),warnings,complete:warnings.length===0});
 }
 getSource(path:string,snapshotId=this.snapshotId):{path:string;content:string;contentHash:string;snapshotId:string;baseCommit:string}|undefined {
  const snapshot=this.snapshot(snapshotId);if(!safeRelativePath(path))throw new Error('Source path must be relative without traversal');
  const document=this.db.prepare('SELECT f.path,f.content_hash,c.content FROM indexed_files f JOIN indexed_contents c ON c.content_hash=f.content_hash WHERE f.snapshot_id=? AND f.path=?').get(snapshot.id,path) as FileDocument|undefined;
  if(!document)return undefined;if(contentHash(document.content)!==document.content_hash)throw new Error('Index content hash mismatch');
  return {path:document.path,content:document.content,contentHash:document.content_hash,snapshotId:snapshot.id,baseCommit:snapshot.base_commit};
 }
 async searchCode(input:SearchInput):Promise<SearchResult>{
  const snapshot=this.snapshot(input.snapshotId??this.snapshotId),scope=normalizeScope(input.scope),limit=input.limit??20;
  if(!input.query.trim()||input.query.length>1000||/[\r\n\0]/.test(input.query))throw new Error('Query must be nonempty, single-line and at most 1000 characters');
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Search limit must be between 1 and 100');
  if(input.engine!==undefined&&!['fts','ripgrep'].includes(input.engine))throw new Error('Unknown search engine');
  const warnings=JSON.parse(snapshot.warnings_json) as IndexWarning[];
  if(input.engine!=='ripgrep')return {snapshotId:snapshot.id,baseCommit:snapshot.base_commit,complete:warnings.length===0,warnings,hits:searchFts(this.db,snapshot.id,input.query,scope,limit)};
  const documents=(this.db.prepare('SELECT f.path,f.content_hash,c.content FROM indexed_files f JOIN indexed_contents c ON c.content_hash=f.content_hash WHERE f.snapshot_id=? ORDER BY f.path').all(snapshot.id) as FileDocument[]).filter(doc=>inScope(doc.path,scope));
  for(const document of documents)if(contentHash(document.content)!==document.content_hash)throw new Error('Index content hash mismatch');
  const hits=await searchWithRipgrep(documents.map(doc=>({path:doc.path,contentHash:doc.content_hash,content:doc.content})),input.query,this.dbPath===':memory:'?process.cwd():dirname(this.dbPath),limit);
  return {snapshotId:snapshot.id,baseCommit:snapshot.base_commit,complete:warnings.length===0,warnings,hits};
 }
}
