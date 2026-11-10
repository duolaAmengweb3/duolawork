#!/usr/bin/env python3
"""Isolated deployment. Credentials never appear in argv or stdout."""
import json, os, pathlib, secrets, subprocess, sys, urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[1]
if json.loads((ROOT/'cloud/wrangler.jsonc').read_text()).get('vars',{}).get('HUB_RELAY_ORIGIN'):
    subprocess.run(['node', str(ROOT/'scripts/deploy-server.mjs')], cwd=ROOT, check=True)
    sys.exit(0)
PRIVATE=pathlib.Path.home()/'.config'/'agent-hub'
PRIVATE.mkdir(parents=True,exist_ok=True,mode=0o700)
CFG=PRIVATE/'config.json'
operator=json.loads((pathlib.Path.home()/'.config/cloudflare/rikhuan93-operator.json').read_text())
assert operator['account_id']=='d9d2d3d737a0e4f3f99bee632ed94f45', 'Unexpected Cloudflare account'
env={**os.environ,'CLOUDFLARE_ACCOUNT_ID':operator['account_id'],'CLOUDFLARE_API_TOKEN':operator['api_token'],'WRANGLER_SEND_METRICS':'false'}
wrangler=ROOT/'node_modules/.bin/wrangler'
def api(path,method='GET',body=None):
    req=urllib.request.Request('https://api.cloudflare.com/client/v4/accounts/'+operator['account_id']+path, method=method, data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+operator['api_token'],'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=45) as r: data=json.load(r)
    if not data.get('success'): raise RuntimeError(str(data.get('errors')))
    return data['result']
def run(args,stdin=None):
    subprocess.run([str(wrangler),*args],cwd=ROOT,env=env,input=stdin,text=True,check=True)
config=json.loads(CFG.read_text()) if CFG.exists() else {}
config.setdefault('adminKey',secrets.token_urlsafe(48))
config.setdefault('runnerId','local-'+secrets.token_hex(8))
config.setdefault('port',8766)
worker=json.loads((ROOT/'cloud/wrangler.jsonc').read_text())
databases=api('/d1/database')
db=next((x for x in databases if x['name']=='agent-hub-local'),None)
if db is None: db=api('/d1/database','POST',{'name':'agent-hub-local'})
worker['d1_databases'][0]['database_id']=db['uuid']
(ROOT/'cloud/wrangler.jsonc').write_text(json.dumps(worker,ensure_ascii=False,indent=2)+'\n')
# Save before deployment, so reruns reuse the same owner credential.
CFG.write_text(json.dumps(config,indent=2)+'\n'); CFG.chmod(0o600)
run(['d1','migrations','apply','agent-hub-local','--remote','--config','cloud/wrangler.jsonc'])
run(['types','--config','cloud/wrangler.jsonc','cloud/env.d.ts'])
run(['secret','put','ADMIN_KEY','--config','cloud/wrangler.jsonc'],config['adminKey']+'\n')
run(['deploy','--config','cloud/wrangler.jsonc'])
sub=api('/workers/subdomain')['subdomain']
config['endpoint']='https://agent-hub-local.'+sub+'.workers.dev'
CFG.write_text(json.dumps(config,indent=2)+'\n'); CFG.chmod(0o600)
print('Deployed isolated Agent Hub:',config['endpoint'])
