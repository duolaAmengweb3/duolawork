import {CONNECTOR_CATALOG} from './connector-catalog.mjs';

// GitHub's remote resource metadata advertises DefaultOAuthScopes, which is a
// subset of SupportedOAuthScopes. Full personal-account access must also cover
// workflow editing, repository deletion and Codespaces. Organization/enterprise
// access is separate and is not requested for this account connection.
// Source: github/github-mcp-server, pkg/scopes/scopes.go.
export const GITHUB_FULL_SCOPES=Object.freeze(['repo','delete_repo','read:user','user:email','read:packages','write:packages','read:project','project','gist','notifications','workflow','codespace']);
const GITHUB_ORGANIZATION_SCOPES=['read:org','write:org','admin:org','admin:org_hook','read:enterprise','admin:enterprise','manage_runners:enterprise','manage_billing:enterprise'];
export function connectorAuthorizationURL(connection,input,metadata){
 const u=new URL(input),scopes=new Set((u.searchParams.get('scope')||'').split(/\s+/).filter(Boolean));
 const supported=metadata?.scopes_supported||[];
 if(supported.includes('offline_access'))scopes.add('offline_access');
 const preset=CONNECTOR_CATALOG.find(p=>p.id===connection.provider);
 const trusted=!!preset?.url&&new URL(preset.url).origin===new URL(connection.url).origin;
 if(trusted&&connection.provider==='github-mcp'&&u.origin==='https://github.com'){
  for(const scope of GITHUB_ORGANIZATION_SCOPES)scopes.delete(scope);
  for(const scope of GITHUB_FULL_SCOPES)scopes.add(scope);
 }
 if(trusted&&connection.provider==='cloudflare'&&u.origin==='https://mcp.cloudflare.com')for(const scope of supported)scopes.add(scope);
 // Vercel resource access is selected on its consent page. Its other advertised
 // scope, ema_issuer:manage, manages authorization infrastructure, not projects.
 if(trusted&&connection.provider==='vercel'&&u.origin==='https://vercel.com')for(const scope of ['openid','email','profile','offline_access'])if(supported.includes(scope))scopes.add(scope);
 if(scopes.size)u.searchParams.set('scope',[...scopes].join(' '));
 if(trusted&&connection.provider.startsWith('google-')&&u.origin==='https://accounts.google.com'){
  u.searchParams.set('access_type','offline');u.searchParams.set('prompt','consent select_account');
 }
 return u;
}
