import {build} from 'esbuild';
import {readFile,rm,mkdir,cp,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),output=join(root,'packages/core/dist');
await rm(output,{recursive:true,force:true});await mkdir(join(output,'assets/core'),{recursive:true});
const paths={
 'packages/core/src/db/migrate.ts':text=>text.replace(/file: '\.\//g,"file: './assets/core/"),
 'packages/context/src/db/client.ts':text=>text.replace("'./index-schema.sql'","'./assets/context/index-schema.sql'"),
 'packages/cli-adapters/src/compat.ts':text=>text.replaceAll('../compat/','./assets/compat/'),
 'packages/verifier/src/checks/playwright.ts':text=>text.replace("'./playwright-worker.mjs'","'./assets/verifier/playwright-worker.mjs'").replace("require.resolve('playwright-core')","fileURLToPath(new URL('./assets/playwright-core/index.js',import.meta.url))"),
};
await build({absWorkingDir:root,entryPoints:['packages/core/src/ipc/cli.ts'],outfile:join(output,'desktop-core.mjs'),bundle:true,platform:'node',target:'node22',format:'esm',external:['better-sqlite3','typescript'],sourcemap:true,plugins:[{name:'runtime-resources',setup(builder){builder.onLoad({filter:/\.ts$/},async args=>{const relative=Object.keys(paths).find(path=>resolve(root,path)===args.path);if(!relative)return;return {contents:paths[relative](await readFile(args.path,'utf8')),loader:'ts'};});}}]});
for(const file of await readdir(join(root,'packages/core/src/db')))if(file.endsWith('.sql'))await cp(join(root,'packages/core/src/db',file),join(output,'assets/core',file));
await mkdir(join(output,'assets/context'),{recursive:true});
await mkdir(join(output,'assets/verifier'),{recursive:true});
await cp(join(root,'packages/context/src/db/index-schema.sql'),join(output,'assets/context/index-schema.sql'),{recursive:true});
await cp(join(root,'packages/cli-adapters/compat'),join(output,'assets/compat'),{recursive:true});
await cp(join(root,'packages/verifier/src/checks/playwright-worker.mjs'),join(output,'assets/verifier/playwright-worker.mjs'));
await cp(join(root,'.adw/playwright-core'),join(output,'assets/playwright-core'),{recursive:true});
console.log('Desktop core built: packages/core/dist/desktop-core.mjs');
