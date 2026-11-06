import { build } from 'esbuild';
import fs from 'node:fs/promises';
const output = 'release/server';
await fs.mkdir(output, { recursive: true });
await build({ entryPoints: ['cloud/worker.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: output + '/worker.mjs', banner: { js: "import {createRequire as __hubRequire} from 'node:module'; const require=__hubRequire(import.meta.url);" } });
await build({entryPoints:['server/object-maintenance.mjs'],bundle:true,platform:'node',format:'esm',target:'node24',outfile:output+'/object-maintenance.mjs'});
for (const file of ['main.mjs', 'memory-client.mjs','memory-ledger.mjs','sqlite.mjs', 'object-store.mjs', 'backup.py']) await fs.copyFile('server/' + file, output + '/' + file);
await fs.cp('cloud/migrations', output + '/migrations', { recursive: true });
console.log('Built standalone server without credentials or workspace data');

await fs.mkdir(output+'/memory-runtime',{recursive:true});
for(const file of ['main.mjs','package.json','package-lock.json'])await fs.copyFile('server/memory-runtime/'+file,output+'/memory-runtime/'+file);
await build({entryPoints:['cloud/collaboration/repository.mjs'],bundle:true,platform:'node',format:'esm',target:'node24',outfile:output+'/memory-runtime/repository.mjs'});
