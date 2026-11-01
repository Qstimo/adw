import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DesktopMethods,DesktopResponseSchema,type DesktopMethod} from '@adw/contracts';
export class CoreProcess {
 private child:ChildProcessWithoutNullStreams;
 private pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 private buffer=Buffer.alloc(0); private closed=false;
 constructor(node:string,binary:string,dataDir:string,private token:string){
  const env:NodeJS.ProcessEnv={...process.env,ADW_DESKTOP_SESSION_TOKEN:token};delete env.ELECTRON_RUN_AS_NODE;
  this.child=spawn(node,[binary,'--data-dir',dataDir],{env,stdio:['pipe','pipe','pipe']});
  this.child.stdout.on('data',(chunk:Buffer)=>{this.buffer=Buffer.concat([this.buffer,chunk]);if(this.buffer.length>2*1024*1024){this.fail(new Error('Core frame too large'));this.child.kill();return;}let end:number;while((end=this.buffer.indexOf(10))>=0){const line=this.buffer.subarray(0,end).toString('utf8');this.buffer=this.buffer.subarray(end+1);try{const reply=DesktopResponseSchema.parse(JSON.parse(line));const call=this.pending.get(reply.id);if(call){clearTimeout(call.timer);this.pending.delete(reply.id);reply.ok?call.resolve(reply.result):call.reject(new Error(reply.error.message));}}catch{this.fail(new Error('Invalid core response'));this.child.kill();}}});
  this.child.stdin.on('error',error=>this.fail(error));
  this.child.stderr.resume(); // Drain without exposing potentially private diagnostics to renderer.
  this.child.on('error',error=>this.fail(error));this.child.on('exit',()=>this.fail(new Error('Core process exited')));
 }
 private fail(error:Error){this.closed=true;for(const call of this.pending.values()){clearTimeout(call.timer);call.reject(error);}this.pending.clear();}
 async invoke(method:DesktopMethod,params:unknown,human=false):Promise<unknown>{
  if(this.closed)throw new Error('Core unavailable');const parsed=DesktopMethods[method].params.parse(params);const id=randomUUID();
  const result=await new Promise<unknown>((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Core request timed out; refresh state before retrying'));},180000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,params:parsed,...(human?{authorization:this.token}:{})})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});});
  return DesktopMethods[method].result.parse(result);
 }
 close(){this.child.stdin.end();const timer=setTimeout(()=>this.child.kill('SIGTERM'),5000);timer.unref();this.child.once('exit',()=>clearTimeout(timer));}
}
