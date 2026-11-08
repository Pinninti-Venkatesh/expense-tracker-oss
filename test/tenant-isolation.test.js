import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');
process.env.TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

const { runAsUser, contextUser } = await import('../server/context.js');
const store = await import('../server/drive/store.js');

/**
 * An in-memory stand-in for Google Drive in which every account has its own
 * separate Drive, exactly as in production: a file id from one account's Drive
 * does not exist in another's.
 */
let files;
let seq;
let failNextUpdateFor;

const fakeDrive = () => {
  const { id: uid } = contextUser();
  const key = (fileId) => `${uid}:${fileId}`;
  return {
    files: {
      list: async () => ({
        data: { files: [...files.keys()].filter((k) => k.startsWith(`${uid}:`)).map((k) => ({ id: k.split(':')[1] })) },
      }),
      create: async ({ media }) => {
        const fileId = `file${++seq}`;
        files.set(key(fileId), media.body);
        return { data: { id: fileId } };
      },
      get: async ({ fileId }) => {
        if (!files.has(key(fileId))) throw new Error('File not found in this Drive');
        return { data: files.get(key(fileId)) };
      },
      update: async ({ fileId, media }) => {
        if (failNextUpdateFor === uid) {
          failNextUpdateFor = null;
          throw new Error('Drive is having a moment');
        }
        if (!files.has(key(fileId))) throw new Error('File not found in this Drive');
        let body = '';
        for await (const chunk of media.body) body += chunk;
        files.set(key(fileId), body);
        return { data: {} };
      },
      delete: async ({ fileId }) => {
        files.delete(key(fileId));
      },
    },
  };
};

const alice = { id: 'alice', email: 'alice@example.com' };
const bob = { id: 'bob', email: 'bob@example.com' };
const as = (user, fn) => runAsUser(user, fn);

beforeEach(() => {
  files = new Map();
  seq = 0;
  failNextUpdateFor = null;
  store.__setDriveForTests(fakeDrive);
});

test("each account reads and writes only its own ledger", async () => {
  await as(alice, () => store.mutate((d) => d.expenses.push({ id: 'a1', amount: 100 })));
  await as(bob, () => store.mutate((d) => d.expenses.push({ id: 'b1', amount: 5 })));

  const aliceIds = await as(alice, async () => (await store.init()).expenses.map((e) => e.id));
  const bobIds = await as(bob, async () => (await store.init()).expenses.map((e) => e.id));

  assert.deepEqual(aliceIds, ['a1']);
  assert.deepEqual(bobIds, ['b1']);
});

test('interleaved writes from two accounts never cross over', async () => {
  const writes = [];
  for (let i = 0; i < 20; i++) {
    writes.push(as(alice, () => store.mutate((d) => d.expenses.push({ id: `a${i}` }))));
    writes.push(as(bob, () => store.mutate((d) => d.expenses.push({ id: `b${i}` }))));
  }
  await Promise.all(writes);

  const aliceIds = await as(alice, () => store.read().expenses.map((e) => e.id));
  const bobIds = await as(bob, () => store.read().expenses.map((e) => e.id));
  assert.equal(aliceIds.length, 20);
  assert.equal(bobIds.length, 20);
  assert.ok(aliceIds.every((id) => id.startsWith('a')));
  assert.ok(bobIds.every((id) => id.startsWith('b')));

  // And what reached each Drive matches what is in memory.
  const persisted = JSON.parse([...files.entries()].find(([k]) => k.startsWith('alice:'))[1]);
  assert.equal(persisted.expenses.length, 20);
});

test('outside an account context the store refuses instead of guessing', async () => {
  assert.throws(() => store.read(), /No account in context/);
  await assert.rejects(store.init(), /No account in context/);
  assert.throws(() => store.mutate(() => {}), /No account in context/);
});

test("deleting one account's ledger leaves every other ledger intact", async () => {
  await as(alice, () => store.mutate((d) => d.expenses.push({ id: 'a1' })));
  await as(bob, () => store.mutate((d) => d.expenses.push({ id: 'b1' })));

  await as(alice, () => store.deleteDataFile());

  assert.equal([...files.keys()].some((k) => k.startsWith('alice:')), false);
  const bobIds = await as(bob, async () => (await store.init()).expenses.map((e) => e.id));
  assert.deepEqual(bobIds, ['b1']);
});

test('a failed Drive write rolls back and does not block later writes', async () => {
  await as(alice, () => store.mutate((d) => d.expenses.push({ id: 'a1' })));

  failNextUpdateFor = 'alice';
  await assert.rejects(as(alice, () => store.mutate((d) => d.expenses.push({ id: 'lost' }))), /having a moment/);
  assert.deepEqual(await as(alice, () => store.read().expenses.map((e) => e.id)), ['a1']);

  await as(alice, () => store.mutate((d) => d.expenses.push({ id: 'a2' })));
  assert.deepEqual(await as(alice, () => store.read().expenses.map((e) => e.id)), ['a1', 'a2']);
});
