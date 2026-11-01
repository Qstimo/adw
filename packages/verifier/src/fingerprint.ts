import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { platform, release, arch } from 'node:os';
export function environmentFingerprint(worktreePath: string, env: NodeJS.ProcessEnv = process.env): string {
 let dir = worktreePath;
 let lock = '';
 while (true) {
  for (const name of ['pnpm-lock.yaml','package-lock.json','yarn.lock']) {
   const file = join(dir, name);
   if (existsSync(file)) { lock = readFileSync(file, 'utf8'); break; }
  }
  if (lock || dirname(dir) === dir) break;
  dir = dirname(dir);
 }
 const manifest = join(worktreePath, 'package.json');
 return createHash('sha256').update(JSON.stringify({ node: process.version, platform: platform(), release: release(), arch: arch(), lock, manifest: existsSync(manifest) ? readFileSync(manifest, 'utf8') : '', env: Object.entries(env).filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)) })).digest('hex');
}
