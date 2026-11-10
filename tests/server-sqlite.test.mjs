import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/sqlite.mjs';
import { Repository } from '../cloud/collaboration/repository.mjs';
const migrations = new URL('../cloud/migrations', import.meta.url).pathname;
test('standalone database preserves transactional rollback, binary data and idempotent collaboration writes', async t => {
  const db = openDatabase(':memory:', migrations); t.after(() => db.close());
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO hub_v2_file_chunks VALUES (?,0,?)").bind('rollback', new Uint8Array([1,2]).buffer),
    db.prepare('SELECT * FROM missing_table'),
  ]));
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM hub_v2_file_chunks").first('n'), 0);
  await db.prepare('INSERT INTO hub_v2_file_chunks VALUES (?,0,?)').bind('binary', new Uint8Array([0,255,42]).buffer).run();
  assert.equal(await db.prepare('SELECT hex(data) AS data FROM hub_v2_file_chunks').first('data'), '00FF2A');
  const repo = new Repository(db, 'isolated');
  const first = await repo.transact('same-request', { body: 'one' }, tx => tx.put('document', { id: 'doc', body: 'one' }));
  const repeated = await repo.transact('same-request', { body: 'one' }, () => { throw Error('must not run twice'); });
  assert.deepEqual(repeated, first);
  await assert.rejects(repo.transact('same-request', { body: 'two' }, () => null), { code: 'idempotency_conflict' });
  assert.equal((await repo.get('document', 'doc')).body, 'one');
});
