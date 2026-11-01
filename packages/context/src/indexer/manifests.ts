import ts from 'typescript';
import { posix } from 'node:path';
import type { DiscoveredCommand, IndexManifest, IndexWarning } from '@adw/contracts';
export function extractManifest(content:string,path:string):{manifest?:IndexManifest;warnings:IndexWarning[]} {
 const name=posix.basename(path),kind=name==='package.json'?'package':/^(tsconfig|jsconfig)(\..+)?\.json$/.test(name)?'tsconfig':undefined;
 if(!kind)return {warnings:[]};
 try {
  let data:unknown;
  if(kind==='tsconfig'){const result=ts.parseConfigFileTextToJson(path,content);if(result.error)throw new Error(ts.flattenDiagnosticMessageText(result.error.messageText,' '));data=result.config;}
  else data=JSON.parse(content.replace(/^\uFEFF/,''));
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Manifest must be an object');
  return {manifest:{path,kind,data},warnings:[]};
 } catch(error){return {warnings:[{code:'manifest_error',path,message:error instanceof Error?error.message:String(error)}]};}
}
export function discoverCommands(manifests:IndexManifest[]):DiscoveredCommand[] {
 const commands:DiscoveredCommand[]=[];
 for(const manifest of manifests){
  if(manifest.kind!=='package')continue;
  const scripts=(manifest.data as {scripts?:unknown}).scripts;
  if(!scripts||typeof scripts!=='object'||Array.isArray(scripts))continue;
  for(const [name,command] of Object.entries(scripts))if(/^(build|typecheck|lint|test(?::.*)?|unit(?::.*)?|e2e(?::.*)?)$/.test(name)&&typeof command==='string'&&command.trim())commands.push({name,command,cwd:posix.dirname(manifest.path),manifestPath:manifest.path});
 }
 return commands.sort((a,b)=>a.manifestPath.localeCompare(b.manifestPath)||a.name.localeCompare(b.name));
}
