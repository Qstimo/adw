import { mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { ArtifactStore,ProjectIndexer,ContextBroker,createContextAPI,type PublishArtifactInput } from '../src/index.js';
export async function contextFixture(){
 const root=mkdtempSync(join(tmpdir(),'adw-broker-')),repo=join(root,'repo');mkdirSync(repo);writeFileSync(join(repo,'app.ts'),'export function add(a:number,b:number){return a+b;}\n');
 const db=new Database(join(root,'core.sqlite'));db.pragma('foreign_keys=ON');db.pragma('journal_mode=WAL');
 db.transaction(()=>{for(const name of ['schema.sql','002-verification-runs.sql','003-context-broker.sql'])db.exec(readFileSync(new URL(`../../core/src/db/${name}`,import.meta.url),'utf8'));})();
 db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run('proj_test',repo,'main','now');
 for(const task of ['task_1','task_2'])db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(task,'proj_test','Implement add',JSON.stringify(['  keep the complete API contract\nincluding this exact line  ']),JSON.stringify(['Do not push']),'main','a'.repeat(40),'locked','now','now');
 const index=await ProjectIndexer.build({projectId:'proj_test',repoPath:repo,baseCommit:'a'.repeat(40),dbPath:join(root,'index.sqlite')});
 const store=new ArtifactStore(db,{projectId:'proj_test',artifactDir:join(root,'artifacts')}),broker=new ContextBroker(store,index);
 const api=createContextAPI(store,index,broker,{taskId:'task_1'}),trusted=createContextAPI(store,index,broker,{taskId:'task_1',trusted:true});
 const sourceHash=index.getProjectMap().files.find(file=>file.path==='app.ts')!.contentHash;
 const input=(extra:Partial<PublishArtifactInput>={}):PublishArtifactInput=>({taskId:'task_1',kind:'decision',content:'Use the add API',baseCommit:'a'.repeat(40),sourcePaths:['app.ts'],sourceHashes:{'app.ts':sourceHash},producerAgent:'codex',confidence:'inferred',visibility:'task',...extra});
 const evidence=store.blobs.put('independent check passed');
 return {root,repo,db,index,store,broker,api,trusted,input,evidence,close(){index.close();db.close();rmSync(root,{recursive:true,force:true});}};
}
