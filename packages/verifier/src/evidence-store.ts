import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
export class EvidenceStore {
 readonly root: string;
 constructor(root: string) { this.root = resolve(root); mkdirSync(this.root, { recursive: true }); }
 put(content: string | Buffer): string {
  const hash = createHash('sha256').update(content).digest('hex');
  const dir = join(this.root, hash.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, hash);
  try { writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
   if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
   if (createHash('sha256').update(readFileSync(file)).digest('hex') !== hash) throw new Error('Evidence content hash mismatch');
  }
  return `sha256:${hash}`;
 }
 get(ref: string): Buffer {
  if (!/^sha256:[a-f0-9]{64}$/.test(ref)) throw new Error('Invalid evidence reference');
  const hash = ref.slice(7);
  const content = readFileSync(join(this.root, hash.slice(0, 2), hash));
  if (createHash('sha256').update(content).digest('hex') !== hash) throw new Error('Evidence content hash mismatch');
  return content;
 }
}
