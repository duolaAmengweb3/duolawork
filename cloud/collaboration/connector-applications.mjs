import {CONNECTOR_CATALOG} from '../../shared/connector-catalog.mjs';
import {seal,unseal} from './security.mjs';

// Registered OAuth applications belong to the workspace, not to an individual
// account. Reuse only for exact trusted catalog origins, never arbitrary URLs.
export function applicationKey(provider,url){
 const preset=CONNECTOR_CATALOG.find(p=>p.id===provider);
 if(!preset?.url||!url||new URL(preset.url).origin!==new URL(url).origin)return null;
 return provider.startsWith('google-')?'google-workspace':provider;
}
export async function configuredApplication(repo,connection,env){
 const key=applicationKey(connection.provider,connection.url);if(!key)return {};
 const row=await repo.get('service_application',key,false);
 return row?.sealed?unseal(row.sealed,env.ADMIN_KEY):{};
}
export async function saveApplication(tx,connection,config,env){
 const key=applicationKey(connection.provider,connection.url);if(!key||!config.oauthClientId)return;
 const old=await tx.get('service_application',key,false);
 const previous=old?.sealed?await unseal(old.sealed,env.ADMIN_KEY):{};
 const value={oauthClientId:config.oauthClientId,...(config.oauthClientSecret?{oauthClientSecret:config.oauthClientSecret}:previous.oauthClientId===config.oauthClientId&&previous.oauthClientSecret?{oauthClientSecret:previous.oauthClientSecret}:{})};
 tx.put('service_application',{id:key,sealed:await seal(value,env.ADMIN_KEY)});
}
