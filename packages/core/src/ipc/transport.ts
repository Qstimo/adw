import {randomUUID,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {DesktopEnvelopeSchema} from '@adw/contracts';
import type {DesktopCoreService} from './server.js';
export const DESKTOP_FRAME_BYTES=2*1024*1024;
const WireSchema=DesktopEnvelopeSchema.extend({authorization:z.string().max(256).optional()});
const failure=(message:string)=>({id:randomUUID(),ok:false as const,error:{code:'invalid_frame',message}});
/** One JSON object per line. The session secret belongs to the native host, never the renderer. */
export class DesktopPipeTransport {
 private pending=Buffer.alloc(0);
 private draining=Promise.resolve();
 private stopped=false;
 constructor(private readonly service:DesktopCoreService,private readonly emit:(frame:unknown)=>void,private readonly token?:string){}
 private authorized(value:string|undefined){
  if(!value||!this.token)return false;
  const supplied=Buffer.from(value),expected=Buffer.from(this.token);
  return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
 }
 private async frame(bytes:Buffer){
  try{
   const wire=WireSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))),{authorization,...request}=wire;
   this.emit(await this.service.handle(request,{humanAuthorized:this.authorized(authorization)}));
  }catch{this.emit(failure('Invalid JSON IPC envelope'));}
 }
 /** Backpressure is supplied by the stdin consumer awaiting this method. */
 async feed(chunk:Buffer):Promise<void>{
  if(this.stopped)throw new Error('IPC stream is closed');
  // A caller must feed sequentially; serialize defensively to preserve frame boundaries.
  const operation=this.draining.then(async()=>{
   if(this.stopped)throw new Error('IPC stream is closed');
   let start=0;
   for(let index=0;index<chunk.length;index++){
    if(chunk[index]!==10)continue;
    const part=chunk.subarray(start,index);
    if(this.pending.length+part.length>DESKTOP_FRAME_BYTES){this.stopped=true;this.pending=Buffer.alloc(0);throw new Error('IPC frame exceeds 2 MiB');}
    const frame=this.pending.length?Buffer.concat([this.pending,part]):part;
    this.pending=Buffer.alloc(0);start=index+1;
    if(frame.length)await this.frame(frame);
   }
   const tail=chunk.subarray(start);
   if(this.pending.length+tail.length>DESKTOP_FRAME_BYTES){this.stopped=true;this.pending=Buffer.alloc(0);throw new Error('IPC frame exceeds 2 MiB');}
   if(tail.length)this.pending=Buffer.concat([this.pending,tail]);
  });
  this.draining=operation.catch(()=>{});return operation;
 }
 async end(){await this.draining;if(this.pending.length&&!this.stopped)this.emit(failure('Incomplete IPC frame at end of stream'));this.pending=Buffer.alloc(0);this.stopped=true;}
}
