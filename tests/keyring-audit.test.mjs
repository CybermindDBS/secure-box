// Key ring edge cases (#19): changes made in two places, ties, recovery keys typed by hand,
// files picked in the wrong place, and old key ring backups.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createKeyring,
  isNewer,
  keyFileKind,
  emergencyKitText,
  parseKeyring,
  serializeKeyring,
  signRevision,
  trustedRevision,
  unlockWithPassword,
  unlockWithRecovery,
  verifyRevision,
  withNewPassword,
  withNewRecovery,
} from '../src/core/keyring.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PASSWORD = 'correct horse battery staple';

async function freshKeyring() {
  const { doc, master, recovery } = await createKeyring(PASSWORD);
  return { doc, master, recovery };
}

/** A copy as another device would read it: parsed again, then verified with the master key. */
async function reread(doc, master) {
  const copy = parseKeyring(serializeKeyring(doc));
  await verifyRevision(copy, master);
  return copy;
}

test('a change made on top of the newest copy keeps the change made elsewhere', async () => {
  const { doc, master } = await freshKeyring();
  // Window A changes the master password…
  const changed = await withNewPassword(doc, master, 'a brand new master password');
  // …window B, which still holds the old copy, first reads the newest one, then makes a new kit.
  const newest = isNewer(await reread(changed, master), doc) ? changed : doc;
  const { doc: withKit } = await withNewRecovery(newest, master);
  assert.equal(trustedRevision(withKit), 3);
  await unlockWithPassword(withKit, 'a brand new master password');
  await assert.rejects(unlockWithPassword(withKit, PASSWORD), { code: 'wrong-password' });
});

test('a change made on a stale copy would undo the other one: that is why changes reread first', async () => {
  const { doc, master } = await freshKeyring();
  const changed = await withNewPassword(doc, master, 'a brand new master password');
  const { doc: staleKit } = await withNewRecovery(doc, master); // made from the old copy
  assert.equal(trustedRevision(changed), trustedRevision(staleKit)); // the tie the fix avoids
  await assert.rejects(unlockWithPassword(staleKit, 'a brand new master password'), { code: 'wrong-password' });
});

test('equal revisions reached apart: the later change wins, the same way on every device', async () => {
  const { doc, master } = await freshKeyring();
  const first = await withNewPassword(doc, master, 'changed on the laptop');
  await pause(5);
  const second = await withNewPassword(doc, master, 'changed on the phone');
  const [a, b] = [await reread(first, master), await reread(second, master)];
  assert.equal(trustedRevision(a), trustedRevision(b));
  assert.equal(isNewer(b, a), true);
  assert.equal(isNewer(a, b), false);
  assert.equal(isNewer(a, a), false);
});

test('the time of a change is signed: altering it makes the copy count as revision 0', async () => {
  const { doc, master } = await freshKeyring();
  const changed = await withNewPassword(doc, master, 'a brand new master password');
  const forged = parseKeyring(serializeKeyring({ ...changed, updated: '2999-01-01T00:00:00.000Z' }));
  assert.equal(await verifyRevision(forged, master), 0);
  assert.equal(isNewer(forged, await reread(changed, master)), false);
});

test('a new revision goes past every revision this browser has seen', async () => {
  const { doc, master } = await freshKeyring();
  const changed = await withNewPassword(doc, master, 'a brand new master password', { after: 7 });
  assert.equal(trustedRevision(changed), 8);
  const { doc: kit } = await withNewRecovery(doc, master, { after: 3 });
  assert.equal(trustedRevision(kit), 4);
  const signed = await signRevision(doc, master, 5);
  assert.equal(await verifyRevision(await reread(signed, master), master), 5);
});

test('a recovery key typed by hand opens the key ring however it is written', async () => {
  const { doc, master, recovery } = await freshKeyring();
  const key = recovery.text;
  const variants = [
    key,
    key.toLowerCase(),
    key.replaceAll('-', ' '),
    key.replaceAll('-', ''),
    `  ${key.replaceAll('-', ' - ')}  `,
    key.replaceAll('0', 'O').replaceAll('1', 'I'),
    key.replaceAll('1', 'l'),
  ];
  for (const typed of variants) {
    const opened = await unlockWithRecovery(doc, typed);
    assert.equal(opened.kid, master.kid, `typed as ${typed}`);
  }
  await assert.rejects(unlockWithRecovery(doc, key.slice(0, -4)), { code: 'bad-recovery' });
});

test('files picked in the wrong place are recognised', async () => {
  const { doc, recovery } = await freshKeyring();
  assert.equal(keyFileKind(serializeKeyring(doc)), 'keyring');
  assert.equal(keyFileKind(emergencyKitText({ email: 'you@example.com', recovery })), 'kit');
  assert.equal(keyFileKind(recovery.text), 'kit');
  assert.equal(keyFileKind('name,username,password\nGitHub,me,secret'), 'other');
  assert.equal(keyFileKind('{"format":"secure-box-vault"}'), 'other');
});

test('an old key ring backup keeps opening with the password of its day, and gives the same master key', async () => {
  const { doc, master } = await freshKeyring();
  const backup = serializeKeyring(doc); // exported before the change
  const changed = await withNewPassword(doc, master, 'a brand new master password');
  const fromBackup = await unlockWithPassword(parseKeyring(backup), PASSWORD);
  assert.equal(fromBackup.kid, master.kid);
  assert.deepEqual([...fromBackup.key], [...master.key]);
  // Once a vault adopted from it is open, the newest copy wins.
  const old = await reread(parseKeyring(backup), master);
  assert.equal(isNewer(await reread(changed, master), old), true);
});
