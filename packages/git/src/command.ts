import { execFile } from 'node:child_process';
export function gitRaw(cwd: string, args: string[], input?: string): Promise<string> {
 return new Promise((resolve, reject) => {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_COMMON_DIR']) delete (env as NodeJS.ProcessEnv)[key];
  const safeArgs=args[0]==='diff'?[args[0],'--no-color','--no-ext-diff','--no-textconv',...args.slice(1)]:args;
  const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', ...safeArgs], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30_000, env }, (error, stdout) => error ? reject(error) : resolve(stdout));
  child.stdin?.on('error', () => { /* execFile reports process failure through its callback. */ });
  child.stdin?.end(input);
 });
}
export async function git(cwd: string, args: string[], input?: string): Promise<string> { return (await gitRaw(cwd, args, input)).trimEnd(); }
