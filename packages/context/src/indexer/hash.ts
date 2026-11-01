import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { safeRelativePath } from './walk.js';
import type { IndexWarning } from '@adw/contracts';
export function contentHash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
export async function readSource(root:string,path:string,maxFileBytes:number,remainingBytes:number):Promise<{text:string;hash:string;size:number}|{warning:IndexWarning;bytesRead:number}> {
  let bytesRead=0;
  const warning=(code:IndexWarning['code'],message:string)=>({warning:{code,path,message},bytesRead});
  if(!safeRelativePath(path))return warning('invalid_path','Source path must remain inside the repository');
  const file=resolve(root,path);
  try {
    if((await lstat(file)).isSymbolicLink()||await realpath(file)!==file)return warning('symlink','Symbolic links are not indexed');
    const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try {
      const before=await handle.stat();
      if(!before.isFile())return warning('read_error','Not a regular file');
      if(before.size>maxFileBytes)return warning('max_file_bytes','File exceeds maxFileBytes');
      if(before.size>remainingBytes)return warning('max_total_bytes','File exceeds remaining maxTotalBytes');
      const buffer=Buffer.alloc(before.size);let bytes=0;
      while(bytes<buffer.length){const result=await handle.read(buffer,bytes,buffer.length-bytes,bytes);if(!result.bytesRead)break;bytes+=result.bytesRead;bytesRead=bytes;}
      const after=await handle.stat();
      if(bytes!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)return warning('unstable_file','File changed while being read; retry indexing');
      const content=buffer.subarray(0,bytes);
      if(content.includes(0))return warning('binary','Binary content is not indexed');
      let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(content);}catch{return warning('binary','Non-UTF-8 content is not indexed');}
      return {text,hash:contentHash(content),size:bytes};
    }finally{await handle.close();}
  }catch(error){return warning((error as NodeJS.ErrnoException).code==='ELOOP'?'symlink':'read_error',error instanceof Error?error.message:String(error));}
}
