/**
 * SpeechQueue のテスト（3〜6 秒待つもの）。時間がかかるので別のファイルにして、ほかのテストと並べて動かす。
 *   node --test test/*.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { SpeechQueue } = require('../scripts/lib/speech-queue');
const h = require('./helpers');

test('合図が書き直され続けているロックは片付けず、合図が止まってから 3 秒で片付ける', async (t) => {
  const workDir = h.makeWorkDir(t);
  const owner = { requestId: 'live-owner', session: 'tab-X' };
  h.plantLock(workDir, { ...owner, beatAt: Date.now() });
  const beat = setInterval(() => h.writeState(workDir, { ...owner, beatAt: Date.now() }), 500);
  t.after(() => clearInterval(beat));

  const queue = h.track(new SpeechQueue('tab-B', workDir).acquire());
  await h.sleep(4000); // 3 秒を超えても、合図が書かれている間は片付けない
  assert.equal(queue.settled, false);
  assert.equal(h.readState(workDir).requestId, 'live-owner');

  clearInterval(beat);
  const lastBeat = h.readState(workDir).beatAt;
  assert.equal(await queue.promise, true);
  const sinceLastBeat = Date.now() - lastBeat;
  assert.ok(sinceLastBeat >= 3000 && sinceLastBeat < 3600, `最後の合図から ${sinceLastBeat}ms で片付けた`);
  assert.notEqual(h.readState(workDir).requestId, 'live-owner');
});

test('state のない古いロックは、フォルダが作り直されていなければ、5 秒の猶予のあとに片付けて取る', async (t) => {
  const workDir = h.makeWorkDir(t);
  h.plantEmptyLock(workDir);
  const queue = new SpeechQueue('tab-B', workDir);
  const started = Date.now();
  assert.equal(await queue.acquire(), true);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4900 && elapsed < 5800, `${elapsed}ms で片付けた`);
  queue.release();
});

test('同じタブの持ち主が、声を止められずに合図を書き続けているときは、5 秒で読まずにあきらめ、持ち主のロックに触らない', async (t) => {
  const workDir = h.makeWorkDir(t);
  const reader = new SpeechQueue('tab-A', workDir);
  assert.equal(await reader.acquire(), true);
  // アサーションが失敗しても、見張りを止めてロックを返してから終わる（作業フォルダを消す前に）
  try {
    const reasons = [];
    reader.startWatching((reason) => reasons.push(reason)); // 声を止められず、ロックを返さないことにする
    const readerRequest = h.readState(workDir).requestId;

    const newer = new SpeechQueue('tab-A', workDir);
    const started = Date.now();
    assert.equal(await newer.acquire(), false);
    const elapsed = Date.now() - started;

    assert.deepEqual(reasons, ['replaced']);
    assert.ok(elapsed >= 4900 && elapsed < 5800, `${elapsed}ms であきらめた`);
    const state = h.readState(workDir);
    assert.equal(state.requestId, readerRequest, '持ち主のロックのまま');
    assert.ok(Date.now() - state.beatAt < 1000, '差し替えに気づいたあとも合図を書き続けている');
  } finally {
    reader.release();
  }
});
