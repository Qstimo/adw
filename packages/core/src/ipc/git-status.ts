import {execFile} from 'node:child_process';
export function projectGit(cwd:string,args:string[]):Promise<string>{
 const env={...process.env,GIT_TERMINAL_PROMPT:'0'};for(const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR'])delete (env as NodeJS.ProcessEnv)[key];
 return new Promise((resolve,reject)=>execFile('git',['-c','core.hooksPath=/dev/null',...args],{cwd,env,encoding:'utf8',maxBuffer:2*1024*1024,timeout:10000},(error,stdout)=>error?reject(error):resolve(stdout.trimEnd())));
}
