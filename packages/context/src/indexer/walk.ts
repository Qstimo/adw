import { isAbsolute, posix } from 'node:path';
import { runRipgrep } from '../search/ripgrep.js';
export function safeRelativePath(path:string):boolean {
  return path.length>0&&!isAbsolute(path)&&!path.includes('\\')&&!path.includes('\0')&&!/^[A-Za-z]:/.test(path)&&path.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
}
export function normalizeScope(scope=''):string {
  if(scope===''||scope==='.')return '';
  if(!safeRelativePath(scope))throw new Error('Scope must be a relative repository path without traversal');
  return posix.normalize(scope);
}
export function inScope(path:string,scope:string):boolean { return !scope||path===scope||path.startsWith(scope+'/'); }
export async function walkFiles(repoPath:string,maxBytes:number,timeoutMs:number):Promise<string[]> {
  const excluded=['.git','.adw','node_modules','.aws','.ssh','.codex','.claude'];
  const globs=excluded.flatMap(name=>['--glob',`!**/${name}`,'--glob',`!**/${name}/**`]);
  globs.push('--glob','!**/.env','--glob','!**/.env.*','--glob','!**/*.pem','--glob','!**/*.key');
  const output=await runRipgrep(['--files','--hidden','--null','--no-require-git',...globs],repoPath,undefined,maxBytes,timeoutMs);
  const paths=new TextDecoder('utf-8',{fatal:true}).decode(output).split('\0').filter(Boolean);
  return [...new Set(paths)].sort((a,b)=>a<b?-1:a>b?1:0);
}
