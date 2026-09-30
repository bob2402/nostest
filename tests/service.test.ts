import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { Store, type State } from '../src/store.ts';
import { SignerService } from '../src/service.ts';
import type { Reply } from '../src/protocol.ts';

const origin = 'https://example.test';
const event = { kind: 1, created_at: 1700000000, tags: [['t', 'nostest']], content: 'Test note' };
function setup() {
  let saved: State | undefined;
  const storage = {
    read: async () => structuredClone(saved),
    write: async (state: State) => { saved = structuredClone(state); },
  };
  const service = new SignerService(new Store(storage));
  return { service, storage, saved: () => saved! };
}
function result<T>(reply: Reply): T {
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.result as T;
}

test('first run creates exactly three distinct accounts, even with concurrent requests', async () => {
  const { service, storage, saved } = setup();
  const replies = await Promise.all(Array.from({ length: 12 }, () => service.request('getPublicKey', {}, origin)));
  assert.equal(new Set(replies.map((reply) => result(reply))).size, 1);
  assert.equal(saved().accounts.length, 3);
  assert.equal(new Set(saved().accounts.map((account) => account.pubkey)).size, 3);
  assert.equal(saved().enabled, true);
  const restarted = new SignerService(new Store(storage));
  assert.equal(result(await restarted.request('getPublicKey', {}, origin)), saved().accounts[0].pubkey);
});

test('public snapshots never include private keys', async () => {
  const { service, saved } = setup();
  const snapshot = await service.admin({ action: 'getState' });
  for (const account of saved().accounts) assert.ok(!JSON.stringify(snapshot).includes(account.secret));
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
});

test('events are valid and caller-supplied signature metadata is replaced', async () => {
  const { service } = setup();
  const pubkey = result(await service.request('getPublicKey', {}, origin));
  const signed = result<Event>(await service.request('signEvent', {
    event: { ...event, pubkey: '0'.repeat(64), id: 'bad', sig: 'bad', extra: 'discard' },
  }, origin));
  assert.equal(signed.pubkey, pubkey);
  assert.equal(signed.content, event.content);
  assert.ok(verifyEvent(signed));
  assert.equal('extra' in signed, false);
});

test('queued account switching uses the correct key before and after the switch', async () => {
  const { service } = setup();
  const initial = await service.admin({ action: 'getState' });
  const before = service.request('signEvent', { event }, origin);
  const switching = service.admin({ action: 'switch', id: initial.accounts[1].id });
  const after = service.request('signEvent', { event }, origin);
  await switching;
  assert.equal(result<Event>(await before).pubkey, initial.accounts[0].pubkey);
  assert.equal(result<Event>(await after).pubkey, initial.accounts[1].pubkey);
});

for (const protocol of ['nip04', 'nip44']) {
  test(`${protocol} encrypts and decrypts across two accounts`, async () => {
    const { service } = setup();
    const { accounts } = await service.admin({ action: 'getState' });
    const plaintext = 'A private test message 🔐';
    const ciphertext = result<string>(await service.request(`${protocol}.encrypt`, {
      peer: accounts[1].pubkey, plaintext,
    }, origin));
    assert.notEqual(ciphertext, plaintext);
    await service.admin({ action: 'switch', id: accounts[1].id });
    assert.equal(result(await service.request(`${protocol}.decrypt`, {
      peer: accounts[0].pubkey, ciphertext,
    }, origin)), plaintext);
  });
}

test('pause rejects every method; resume restores signing', async () => {
  const { service } = setup();
  await service.admin({ action: 'setEnabled', enabled: false });
  for (const method of ['getPublicKey', 'peekPublicKey', 'getRelays', 'signEvent', 'nip04.encrypt', 'nip44.decrypt']) {
    const reply = await service.request(method, { event }, origin);
    assert.equal(reply.ok, false);
    if (!reply.ok) assert.match(reply.error, /paused/);
  }
  await service.admin({ action: 'setEnabled', enabled: true });
  assert.ok(verifyEvent(result(await service.request('signEvent', { event }, origin))));
});

test('invalid inputs are rejected and do not poison the request queue', async () => {
  const { service } = setup();
  for (const invalid of [null, { ...event, tags: [123] }, { ...event, kind: -1 },
    { ...event, kind: 1.5 }, { ...event, created_at: Infinity }, { ...event, content: 123 }]) {
    assert.equal((await service.request('signEvent', { event: invalid }, origin)).ok, false);
  }
  assert.equal((await service.request('nip44.encrypt', { peer: 'bad', plaintext: 'test' }, origin)).ok, false);
  await assert.rejects(service.request('delete', {}, origin), /Unsupported/);
  await assert.rejects(service.request('getPublicKey', null, origin), /parameters/);
  await assert.rejects(service.request('getPublicKey', {}, 'file:///test'), /HTTP/);
  assert.equal((await service.request('getPublicKey', {}, origin)).ok, true);
});

test('account generation, rename and deletion preserve account invariants', async () => {
  const { service } = setup();
  const initial = await service.admin({ action: 'getState' });
  const added = await service.admin({ action: 'generate', count: 5 });
  assert.equal(added.accounts.length, 8);
  assert.equal(added.activeId, initial.activeId);
  await service.admin({ action: 'rename', id: initial.activeId, name: '  Alice  ' });
  assert.equal((await service.admin({ action: 'getState' })).accounts[0].name, 'Alice');
  const deleted = await service.admin({ action: 'delete', id: initial.activeId });
  assert.equal(deleted.activeId, initial.accounts[1].id);
  for (const account of deleted.accounts.slice(1)) await service.admin({ action: 'delete', id: account.id });
  await assert.rejects(service.admin({ action: 'delete', id: deleted.activeId }), /at least one/);
  await assert.rejects(service.admin({ action: 'switch', id: 'missing' }), /not found/);
  await assert.rejects(service.admin({ action: 'rename', id: deleted.activeId, name: ' ' }), /name/);
});

test('generation enforces batch and total limits without partial writes', async () => {
  const { service } = setup();
  for (const count of [0, -1, 21, 1.5, NaN]) {
    await assert.rejects(service.admin({ action: 'generate', count }), /between 1 and 20/);
  }
  for (let i = 0; i < 4; i++) await service.admin({ action: 'generate', count: 20 });
  await service.admin({ action: 'generate', count: 17 });
  await assert.rejects(service.admin({ action: 'generate', count: 1 }), /limit/);
  await assert.rejects(service.admin({ action: 'import', nsec: nsecEncode(generateSecretKey()) }), /limit/);
  assert.equal((await service.admin({ action: 'getState' })).accounts.length, 100);
});

test('logs are bounded metadata only and can be cleared', async () => {
  const { service } = setup();
  for (let i = 0; i < 55; i++) {
    await service.request('signEvent', { event: { ...event, content: 'SECRET_PAYLOAD' } }, origin);
  }
  const { logs } = await service.admin({ action: 'getState' });
  assert.equal(logs.length, 50);
  assert.equal(logs[0].origin, origin);
  assert.equal(logs[0].method, 'signEvent');
  assert.ok(!JSON.stringify(logs).includes('SECRET_PAYLOAD'));
  assert.equal((await service.admin({ action: 'clearLogs' })).logs.length, 0);
});

test('nsec import preserves active account and pause state, persists, and signs with the imported key', async () => {
  const { service, storage } = setup();
  const initial = await service.admin({ action: 'setEnabled', enabled: false });
  const key = generateSecretKey();
  const nsec = nsecEncode(key);
  const pubkey = getPublicKey(key);
  const snapshot = await service.admin({ action: 'import', nsec: `  ${nsec.toUpperCase()}\n`, name: '  Imported Alice  ' });
  assert.equal(snapshot.accounts.length, 4);
  assert.equal(snapshot.activeId, initial.activeId);
  assert.equal(snapshot.enabled, false);
  const imported = snapshot.accounts[3];
  assert.equal(imported.name, 'Imported Alice');
  assert.equal(imported.pubkey, pubkey);
  assert.equal(imported.npub, npubEncode(pubkey));
  assert.ok(!JSON.stringify(snapshot).includes(nsec));
  assert.ok(!JSON.stringify(snapshot).includes(Buffer.from(key).toString('hex')));
  await service.admin({ action: 'switch', id: imported.id });
  await service.admin({ action: 'setEnabled', enabled: true });
  const restarted = new SignerService(new Store(storage));
  const signed = result<Event>(await restarted.request('signEvent', { event }, origin));
  assert.equal(signed.pubkey, pubkey);
  assert.ok(verifyEvent(signed));
});

test('duplicate imports are rejected atomically, including generated accounts', async () => {
  const { service, saved } = setup();
  await service.admin({ action: 'getState' });
  const existing = nsecEncode(Buffer.from(saved().accounts[0].secret, 'hex'));
  await assert.rejects(service.admin({ action: 'import', nsec: existing }), /already exists/);
  const nsec = nsecEncode(generateSecretKey());
  const results = await Promise.allSettled([
    service.admin({ action: 'import', nsec }),
    service.admin({ action: 'import', nsec }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
  const snapshot = await service.admin({ action: 'getState' });
  assert.equal(snapshot.accounts.length, 4);
  assert.equal(snapshot.accounts[3].name, 'Imported Account 04');
  assert.equal(saved().nextNumber, 5);
});

test('invalid nsec imports do not expose input or change stored accounts', async () => {
  const { service, saved } = setup();
  await service.admin({ action: 'getState' });
  const before = structuredClone(saved());
  const key = generateSecretKey();
  const valid = nsecEncode(key);
  const badChecksum = valid.slice(0, -1) + (valid.endsWith('q') ? 'p' : 'q');
  const invalid: unknown[] = [
    undefined, null, 123, '', 'nsec1invalid', 'x'.repeat(5000),
    npubEncode(getPublicKey(key)), Buffer.from(key).toString('hex'), badChecksum,
    'N' + valid.slice(1), nsecEncode(new Uint8Array(31)),
    nsecEncode(new Uint8Array(32)), nsecEncode(new Uint8Array(32).fill(255)),
  ];
  for (const nsec of invalid) {
    await assert.rejects(service.admin({ action: 'import', nsec: nsec as string }), (error: Error) => {
      assert.equal(error.message, 'Invalid nsec private key. Check the format and checksum');
      return true;
    });
    assert.deepEqual(saved(), before);
  }
  await assert.rejects(service.admin({ action: 'import', nsec: valid, name: 'x'.repeat(61) }), /name/);
  assert.deepEqual(saved(), before);
  assert.equal((await service.admin({ action: 'import', nsec: valid, name: '  ' })).accounts.length, 4);
});

test('corrupt storage is not silently replaced with new private keys', async () => {
  let wrote = false;
  const store = new Store({
    read: async () => ({ version: 99 }),
    write: async () => { wrote = true; },
  });
  await assert.rejects(store.transact(() => {}), /corrupt or incompatible/);
  assert.equal(wrote, false);
});
