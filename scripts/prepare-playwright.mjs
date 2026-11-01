import {readFileSync,writeFileSync,mkdirSync,existsSync,mkdtempSync,rmSync,renameSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join,relative,isAbsolute,sep} from 'node:path';
import {spawn} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const archive=join(root,'vendor/playwright-core-1.49.1.tgz');
const expected='fc7544a2dbc24341dfc63c4a67c62ce593bc2e7e3257690f2d12d2f7d2b2d636';
if(createHash('sha256').update(readFileSync(archive)).digest('hex')!==expected)throw new Error('Vendored Playwright integrity mismatch');
const dataDir=join(root,'.adw');mkdirSync(dataDir,{recursive:true});
const rel=relative(realpathSync(root),realpathSync(dataDir));if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw new Error('Runtime cache must be inside the workspace');
const destination=join(dataDir,'playwright-core'),marker=join(destination,'.adw-runtime-integrity');
if(!existsSync(marker)||readFileSync(marker,'utf8')!==expected){
 const stage=mkdtempSync(join(dataDir,'.playwright-stage-'));
 try{
  const code=await new Promise((resolve,reject)=>{const child=spawn('tar',['-xzf',archive,'--strip-components=1','-C',stage],{stdio:'inherit'});child.once('error',reject);child.once('close',resolve);});
  if(code!==0)throw new Error('Cannot extract cached Playwright runtime');
  const manifest=JSON.parse(readFileSync(join(stage,'package.json'),'utf8'));if(manifest.name!=='playwright-core'||manifest.version!=='1.49.1')throw new Error('Unexpected Playwright runtime');
  writeFileSync(join(stage,'.adw-runtime-integrity'),expected);rmSync(destination,{recursive:true,force:true});renameSync(stage,destination);
 }finally{rmSync(stage,{recursive:true,force:true});}
}
