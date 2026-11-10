import test from 'node:test';
import assert from 'node:assert/strict';
import { relayRequest } from '../cloud/relay.mjs';
test('relay is opt-in; migration gate prevents dispatch; original endpoint and credentials are preserved', async () => {
  const request = new Request('https://original.example/v2/mcp?cursor=123', { method: 'POST', headers: { authorization: 'Bearer fixture', 'x-hub-public-origin': 'https://forged.example', 'x-hub-gateway-secret': 'forged', 'cf-connecting-ip': '192.0.2.1' }, body: 'fixture-body' });
  assert.equal(await relayRequest(request, {}), null);
  const denied = await relayRequest(request, { HUB_MAINTENANCE: '1' }, () => { throw Error('must not dispatch'); });
  assert.equal(denied.status, 503);
  const env = { HUB_RELAY_ORIGIN: 'https://new.example', HUB_RELAY_SECRET: 'secret' };
  const response = await relayRequest(request, env, async (url, options) => {
    assert.equal(String(url), 'https://new.example/v2/mcp?cursor=123');
    assert.equal(options.headers.get('authorization'), 'Bearer fixture');
    assert.equal(options.headers.get('x-hub-public-origin'), 'https://original.example');
    assert.equal(options.headers.get('x-hub-gateway-secret'), 'secret');
    assert.equal(options.headers.get('x-hub-client-ip'), '192.0.2.1');
    assert.equal(await new Response(options.body).text(), 'fixture-body');
    return new Response('result', { status: 200 });
  });
  assert.equal(await response.text(), 'result');
  assert.equal((await relayRequest(new Request('https://original.example/'), env, () => { throw Error('offline'); })).status, 503);
  assert.equal((await relayRequest(new Request('https://original.example/'), { ...env, HUB_RELAY_ORIGIN: 'http://insecure.example' })).status, 503);
});
