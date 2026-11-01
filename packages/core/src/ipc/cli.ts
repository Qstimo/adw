import {createReadStream,writeSync} from 'node:fs';
import {DesktopCoreService} from './server.js';
import {DesktopPipeTransport} from './transport.js';
const args=process.argv.slice(2);
const dataIndex=args.indexOf('--data-dir'),dataDir=dataIndex>=0?args[dataIndex+1]:undefined;
const sessionToken=process.env.ADW_DESKTOP_SESSION_TOKEN;
// Agent processes inherit the environment later. Never let a host authorization secret reach them.
delete process.env.ADW_DESKTOP_SESSION_TOKEN;
const output=(value:unknown)=>writeSync(1,JSON.stringify(value)+'\n');
async function main(){
 if(!dataDir||args.some((arg,index)=>index!==dataIndex&&index!==dataIndex+1&&arg!=='--health'))throw new Error('Usage: desktop-core --data-dir <external-directory> [--health]');
 if(sessionToken&&(sessionToken.length<32||sessionToken.length>256))throw new Error('Invalid desktop host session token');
 const service=new DesktopCoreService({dataDir});
 // Read the inherited descriptor as a stream: Node's process.stdin wraps socketpair
 // descriptors in net.Socket, which requires socket operations even for local stdio.
 const input=createReadStream('',{fd:0,autoClose:false,highWaterMark:65536});
 let closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{input.destroy();await service.close();})();
 const stop=()=>{void close().then(()=>process.exit(0),()=>process.exit(1));};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  if(args.includes('--health')){output({status:'ok'});return;}
  const transport=new DesktopPipeTransport(service,output,sessionToken);
  try{for await(const chunk of input)await transport.feed(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));await transport.end();}
  catch(error){if(!closing)throw error;}
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await close();}
}
main().catch(error=>{writeSync(2,`${error instanceof Error?error.message:'Desktop core failed'}\n`);process.exitCode=1;});
