import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createShop, handleMessage } from './app.mjs';
import { CreditStore } from './store.mjs';

test('bot checkout credits the requester once, then charges once per distinct exercise', async (t) => {
  const store = new CreditStore(':memory:');
  const server = createShop(store);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const replies = [];
  const telegram = { async call(method, reply) { assert.equal(method, 'sendMessage'); replies.push(reply); } };
  const send = (messageId, text, userId = 41) => handleMessage(store, telegram, origin, {
    chat: { type: 'private', id: userId }, from: { id: userId }, message_id: messageId, text,
  });

  await send(1, '/buy');
  const shop = new URL(replies.at(-1).reply_markup.inline_keyboard[0][0].url);
  const opening = await fetch(shop);
  assert.equal(opening.status, 200);
  assert.match(await opening.text(), /اختار باقة تجريبية/);
  const ticket = shop.searchParams.get('ticket');
  const post = (pack) => fetch(new URL('/shop', origin), {
    method: 'POST', body: new URLSearchParams({ ticket, pack, userId: '99' }),
  });
  const invalid = await post('999');
  assert.equal(invalid.status, 400);
  assert.equal(store.balance(41), 0);

  const responses = await Promise.all([post('3'), post('3')]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.match(await response.text(), /تم الشحن بنجاح/);
  }
  const replay = await post('25');
  assert.match(await replay.text(), /انضاف 3 كريديت/);
  assert.equal(store.balance(99), 0);
  await send(2, '/balance');
  assert.match(replies.at(-1).text, /رصيدك 3 كريديت/);
  await send(3, '/simulate review');
  assert.match(replies.at(-1).text, /بانتظار المراجعة/);
  await send(3, '/simulate review');
  assert.equal(store.balance(41), 2);
  await send(4, '/simulate unknown');
  assert.equal(store.balance(41), 2);
  await Promise.all([send(5, '/simulate'), send(6, '/simulate'), send(7, '/simulate')]);
  assert.equal(store.balance(41), 0);
  assert.equal(replies.filter(({ text }) => text.includes('ما في رصيد كافي')).length, 1);
});

test('balances and exercise receipts persist after reopening the database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-credit-lab-'));
  const path = join(directory, 'test.sqlite');
  try {
    const original = new CreditStore(path);
    const issuedAt = 1000;
    let ticket;
    try {
      ticket = original.issueTicket(9, issuedAt);
      assert.equal(original.redeem(ticket, 3, issuedAt).balance, 3);
      assert.equal(original.runExercise(9, 1, 'eligible').balance, 2);
    } finally {
      original.close();
    }

    const reopened = new CreditStore(path);
    try {
      assert.equal(reopened.balance(9), 2);
      assert.equal(reopened.runExercise(9, 1, 'eligible').balance, 2);
      assert.equal(reopened.redeem(ticket, 10, issuedAt).credits, 3);
      assert.equal(reopened.redeem(ticket, 3, issuedAt + 15 * 60 * 1000), null);
      assert.equal(reopened.redeem(undefined, 3, issuedAt), null);
    } finally {
      reopened.close();
    }
  } finally {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
    rmdirSync(directory);
  }
});
