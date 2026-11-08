import fs from 'node:fs/promises';
import path from 'node:path';

// Common CodingMemberClient dependencies travel with every native bridge.
// Native bridges must import outside the checkout, not rely on files left here.
export async function nativeBridgeFiles(source,names){
 const local=[...new Set([...names,'credential-client.mjs'])];
 const manifest=[...local.map(name=>({relative:'local/'+name,file:path.join(source,name)})),{relative:'shared/vault-references.mjs',file:path.join(source,'../shared/vault-references.mjs')}];
 return Promise.all(manifest.map(async item=>({relative:item.relative,bytes:await fs.readFile(item.file)})));
}
export async function writeNativeBridgeFiles(directory,files){for(const file of files){const target=path.join(directory,file.relative);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,file.bytes);}}
