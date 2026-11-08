import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {Agent,fetch as networkFetch} from 'undici';
// Resolve at connection time and pin the checked answer for the socket. The
// shared remote client must never become a proxy to this server's local network.
function publicAddress(ip){
 if(isIP(ip)===4){const a=ip.split('.').map(Number);return !([0,10,127].includes(a[0])||a[0]>=224||a[0]===169&&a[1]===254||a[0]===172&&a[1]>=16&&a[1]<=31||a[0]===192&&a[1]===168||a[0]===100&&a[1]>=64&&a[1]<=127||a[0]===198&&[18,19].includes(a[1]));}
 return isIP(ip)===6&&/^2[0-9a-f]{3}:/i.test(ip)&&!/^2001:(?:db8|0):/i.test(ip);
}
const dispatcher=new Agent({connect:{lookup(hostname,options,callback){lookup(hostname,{all:true}).then(rows=>{if(!rows.length||rows.some(r=>!publicAddress(r.address)))throw Error('Remote MCP address is not public');callback(null,options.all?rows:rows[0].address,rows[0].family);}).catch(callback);}}});
export function connectorResponse(response){
 // The SDK uses instanceof Response when reading OAuth error bodies. npm
 // undici and Node's built-in fetch have separate constructors; normalize at
 // this boundary so real provider errors do not become "[object Response]".
 const result=new Response(response.body,{status:response.status,statusText:response.statusText,headers:response.headers});
 Object.defineProperty(result,'url',{value:response.url});
 return result;
}
export const connectorFetch=async(url,init={})=>connectorResponse(await networkFetch(url,{...init,redirect:'error',dispatcher}));
export {publicAddress};
