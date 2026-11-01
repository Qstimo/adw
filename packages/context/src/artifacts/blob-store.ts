import { randomUUID,createHash } from 'node:crypto';
import { mkdirSync,realpathSync,openSync,closeSync,fstatSync,readSync,writeFileSync,linkSync,unlinkSync,fsyncSync,constants } from 'node:fs';
import { join,resolve,relative,isAbsolute,sep } from 'node:path';
export const MAX_BLOB_BYTES=16*1024*1024;
export function isInside(parent:string,child:string):boolean {const rel=relative(parent,child);return !rel||(!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel));}
export class BlobStore {
 readonly root:string;
 constructor(root:string,repoPath:string){
  const requested=resolve(root);if(isInside(repoPath,requested))throw new Error('Artifact storage must be outside the repository');
  mkdirSync(requested,{recursive:true,mode:0o700});this.root=realpathSync(requested);
  if(isInside(repoPath,this.root))throw new Error('Artifact storage resolves inside the repository');
 }
 private file(ref:string):string {
  if(!/^sha256:[a-f0-9]{64}$/.test(ref))throw new Error('Invalid content reference');
  const hash=ref.slice(7),dir=join(this.root,hash.slice(0,2));
  if(realpathSync(dir)!==dir)throw new Error('Symlinked content shard');return join(dir,hash);
 }
 put(content:string|Buffer):string {
  const bytes=Buffer.isBuffer(content)?content:Buffer.from(content,'utf8');if(bytes.length>MAX_BLOB_BYTES)throw new Error('Content exceeds the 16 MiB blob limit');
  const hash=createHash('sha256').update(bytes).digest('hex'),ref=`sha256:${hash}`,dir=join(this.root,hash.slice(0,2));mkdirSync(dir,{recursive:true,mode:0o700});const file=this.file(ref);
  const temporary=join(dir,`.pending-${randomUUID()}`);
  const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW??0),0o600);
  try{try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
   try{linkSync(temporary,file);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(!this.get(ref).equals(bytes))throw new Error('Content hash mismatch');}
  }finally{unlinkSync(temporary);}
  if(process.platform==='linux'){const dirFd=openSync(dir,constants.O_RDONLY);try{fsyncSync(dirFd);}finally{closeSync(dirFd);}}
  return ref;
 }
 get(ref:string):Buffer {
  const fd=openSync(this.file(ref),constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>MAX_BLOB_BYTES)throw new Error('Invalid content blob');const bytes=Buffer.alloc(stat.size+1);let offset=0;while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,null);if(!count)break;offset+=count;}
   const content=bytes.subarray(0,offset);if(createHash('sha256').update(content).digest('hex')!==ref.slice(7))throw new Error('Content hash mismatch');return content;
  }finally{closeSync(fd);}
 }
 text(ref:string):string{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(this.get(ref));}
 path(ref:string):string{this.get(ref);return this.file(ref);}
}
