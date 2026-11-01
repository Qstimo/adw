import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['electron/main.ts'],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:'dist/main.cjs'});
await build({entryPoints:['electron/preload.ts'],bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:'dist/preload.cjs'});
await build({entryPoints:['src/main.tsx'],bundle:true,platform:'browser',format:'esm',outfile:'dist/renderer.js',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
await copyFile('index.html','dist/index.html');
