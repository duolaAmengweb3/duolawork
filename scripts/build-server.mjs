import { build } from 'esbuild';
import fs from 'node:fs/promises';
const output = 'release/server';
await fs.mkdir(output, { recursive: true });
await build({ entryPoints: ['cloud/worker.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node24', outfile: output + '/worker.mjs', banner: { js: "import {createRequire as __hubRequire} from 'node:module'; const require=__hubRequire(import.meta.url);" } });
await build({entryPoints:['server/object-maintenance.mjs'],bundle:true,platform:'node',format:'esm',target:'node24',outfile:output+'/object-maintenance.mjs'});
for (const file of ['main.mjs', 'sqlite.mjs', 'object-store.mjs', 'backup.py']) await fs.copyFile('server/' + file, output + '/' + file);
await fs.cp('cloud/migrations', output + '/migrations', { recursive: true });
console.log('Built standalone server without credentials or workspace data');
