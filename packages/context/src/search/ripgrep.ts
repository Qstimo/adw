import { spawn } from 'node:child_process';
export async function runRipgrep(args: string[], cwd: string, input: string | undefined, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve,reject) => {
    const child=spawn('rg',['--no-config',...args],{cwd,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    const chunks:Buffer[]=[];let bytes=0,diagnostic='',failure:Error|undefined;
    const kill=()=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')failure??=new Error(String(error));}};
    const timeout=setTimeout(()=>{failure=new Error('ripgrep timed out');kill();},timeoutMs);
    child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>maxBytes){failure??=new Error('ripgrep output limit exceeded');kill();}else chunks.push(chunk);});
    child.stderr.on('data',(chunk:Buffer)=>{diagnostic=(diagnostic+chunk.toString()).slice(0,4096);});
    child.on('error',error=>{failure=new Error((error as NodeJS.ErrnoException).code==='ENOENT'?'ripgrep (rg) is required; install it and add it to PATH':error.message);});
    child.stdin.on('error',error=>{if((error as NodeJS.ErrnoException).code!=='EPIPE'){failure??=new Error(String(error));kill();}});
    child.on('exit',kill);
    child.on('close',(code,signal)=>{clearTimeout(timeout);kill();if(failure)reject(failure);else if(signal||!(code===0||code===1))reject(new Error(`ripgrep failed (${signal??code}): ${diagnostic}`));else resolve(Buffer.concat(chunks));});
    child.stdin.end(input);
  });
}

export interface SearchDocument { path:string; content:string; contentHash:string }
export async function searchWithRipgrep(documents:SearchDocument[],query:string,cwd:string,limit:number):Promise<{path:string;contentHash:string;lineNumber:number;line:string;source:'ripgrep'}[]> {
  if(!documents.length)return [];
  // Search frozen indexed bytes via stdin: results cannot silently refer to a
  // different live file revision than the snapshot shown to a broker.
  let offset=0;
  const ranges=documents.map(document=>{
    const text=document.content.endsWith('\n')?document.content:document.content+'\n';
    const start=offset+1;offset+=(text.match(/\n/g)??[]).length;
    return {...document,text,start,end:offset};
  });
  const output=await runRipgrep(['--json','--line-number','--fixed-strings','--encoding','none','--text','--max-count',String(limit),'-e',query,'--','-'],cwd,ranges.map(r=>r.text).join(''),8*1024*1024,10_000);
  const hits:{path:string;contentHash:string;lineNumber:number;line:string;source:'ripgrep'}[]=[];
  let rangeIndex=0;
  for(const record of output.toString('utf8').split('\n').filter(Boolean)){
    const event=JSON.parse(record) as {type:string;data?:{line_number?:number;lines?:{text?:string}}};
    if(event.type!=='match')continue;
    const line=event.data?.line_number,text=event.data?.lines?.text;
    if(!Number.isInteger(line)||line===undefined||typeof text!=='string')throw new Error('Invalid ripgrep match record');
    while(ranges[rangeIndex]&&line>ranges[rangeIndex]!.end)rangeIndex++;
    const range=ranges[rangeIndex];if(!range||line<range.start)throw new Error('ripgrep match outside snapshot');
    hits.push({path:range.path,contentHash:range.contentHash,lineNumber:line-range.start+1,line:text.replace(/\r?\n$/,''),source:'ripgrep'});
  }
  return hits;
}
