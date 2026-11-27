/**
 * SpeechQueue のテスト（短い時間で終わるもの）
 *   node --test test/*.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SpeechQueue } = require('../scripts/lib/speech-queue');
const h = require('./helpers');

test('同じタブの新しい要求が来ると、読んでいる本人が自分の声を止めてロックを返し、新しい要求が取る', async (t) => {
  const workDir = h.makeWorkDir(t);
  const reader = new SpeechQueue('tab-A', workDir);
  assert.equal(await reader.acquire(), true);
  const readerRequest = h.readState(workDir).requestId;

  const reasons = [];
  // 声を止めると読み上げが終わり、release() が呼ばれる流れをまねる
  reader.startWatching((reason) => {
    reasons.push(reason);
    setImmediate(() => reader.release());
  });

  const newer = new SpeechQueue('tab-A', workDir);
  const started = Date.now();
  assert.equal(await newer.acquire(), true);
  const elapsed = Date.now() - started;

  assert.deepEqual(reasons, ['replaced']);
  assert.ok(elapsed < 1000, `差し替えに ${elapsed}ms かかった`);
  const state = h.readState(workDir);
  assert.equal(state.session, 'tab-A');
  assert.notEqual(state.requestId, readerRequest);
  newer.release();
  assert.equal(fs.existsSync(h.lockDir(workDir)), false);
});

test('別のタブは、ロックが返されるまで順番を待ち、返されたら 0.15 秒の間隔ですぐに取る', async (t) => {
  const workDir = h.makeWorkDir(t);
  const reader = new SpeechQueue('tab-A', workDir);
  assert.equal(await reader.acquire(), true);
  reader.startWatching(() => assert.fail('別のタブの要求で止めてはいけない'));

  const other = h.track(new SpeechQueue('tab-B', workDir).acquire());
  await h.sleep(800);
  assert.equal(other.settled, false, '持ち主が読んでいる間は待つ');
  assert.equal(h.readState(workDir).session, 'tab-A');

  const releasedAt = Date.now();
  reader.release();
  assert.equal(await other.promise, true);
  const gap = Date.now() - releasedAt;
  assert.ok(gap < 400, `ロックが返されてから取るまでに ${gap}ms かかった`);
  assert.equal(h.readState(workDir).session, 'tab-B');
});

test('読んでいる間は、0.5 秒ごとに合図（beatAt）を書き直す', async (t) => {
  const workDir = h.makeWorkDir(t);
  const reader = new SpeechQueue('tab-A', workDir);
  assert.equal(await reader.acquire(), true);
  t.after(() => reader.release());
  reader.startWatching(() => {});
  const first = h.readState(workDir).beatAt;
  await h.sleep(1300);
  const later = h.readState(workDir).beatAt;
  assert.ok(later - first >= 900, `合図が ${later - first}ms しか進んでいない`);
});

test('合図が 3 秒より古いロックは、持ち主がいないものとして片付けて取る', async (t) => {
  const workDir = h.makeWorkDir(t);
  h.plantLock(workDir, { requestId: 'dead-owner', session: 'tab-X', beatAt: Date.now() - 3500 });
  const queue = new SpeechQueue('tab-B', workDir);
  const started = Date.now();
  assert.equal(await queue.acquire(), true);
  assert.ok(Date.now() - started < 1000);
  assert.notEqual(h.readState(workDir).requestId, 'dead-owner');
  queue.release();
});

test('合図を書いているときに、ロックがほかの要求のものになっていたら、自分の声を止めて相手のロックに触らない', async (t) => {
  const workDir = h.makeWorkDir(t);
  const reader = new SpeechQueue('tab-A', workDir);
  assert.equal(await reader.acquire(), true);
  const reasons = [];
  reader.startWatching((reason) => reasons.push(reason));

  // 合図が途切れた間に片付けられ、ほかのタブに取られたことにする
  const taken = { requestId: 'other-tab-request', session: 'tab-B', beatAt: Date.now() };
  h.writeState(workDir, taken);
  await h.waitFor(() => reasons.length > 0, 1500, '取られたことに気づく');
  assert.deepEqual(reasons, ['lost']);

  reader.release();
  assert.equal(fs.existsSync(h.lockDir(workDir)), true, '相手のロックを消してはいけない');
  assert.deepEqual(h.readState(workDir), taken, '相手の state を書き換えてはいけない');
});

test('合図を書いているときに、state がなくなっていたら、ロックを失ったとして自分の声を止め、ロックに触らない', async (t) => {
  const workDir = h.makeWorkDir(t);
  const reader = new SpeechQueue('tab-A', workDir);
  assert.equal(await reader.acquire(), true);
  const reasons = [];
  reader.startWatching((reason) => reasons.push(reason));

  // 片付けられたあと、ほかのタブがロックを取り直して、まだ state を書いていないところ
  fs.rmSync(h.stateFile(workDir));
  await h.waitFor(() => reasons.length > 0, 1500, 'state がなくなったことに気づく');
  assert.deepEqual(reasons, ['lost']);

  reader.release();
  assert.equal(fs.existsSync(h.lockDir(workDir)), true, 'ほかのタブのロックかもしれないので消さない');
  assert.equal(fs.existsSync(h.stateFile(workDir)), false);
});

test('合図が古いと判定したあと、消す直前に state がなくなっていたら、そのロックは消さない', async (t) => {
  const workDir = h.makeWorkDir(t);
  h.plantLock(workDir, { requestId: 'dead-owner', session: 'tab-X', beatAt: Date.now() - 3500 });
  let recreated = null;
  // 1回目: 様子を調べる（合図が古い） / 2回目: 消す直前の読み直し。その直前に、ほかのタブが片付けて取り直したことにする
  const restore = h.hookLockStat(workDir, {
    before(count) {
      if (count !== 2) return;
      fs.rmSync(h.stateFile(workDir));
      fs.rmdirSync(h.lockDir(workDir));
      fs.mkdirSync(h.lockDir(workDir));
      recreated = h.lockIdentity(workDir);
    },
  });
  t.after(restore);

  const queue = h.track(new SpeechQueue('tab-B', workDir).acquire());
  await h.waitFor(() => recreated !== null, 2000, '読み直しまで進む');
  await h.sleep(400);
  restore();
  assert.equal(queue.settled, false);
  assert.equal(h.lockIdentity(workDir), recreated, '取り直されたロックを消してはいけない');

  fs.rmdirSync(h.lockDir(workDir)); // 取り直したタブが返したことにして、待っている要求を終わらせる
  assert.equal(await queue.promise, true);
});

test('合図が古いと判定したあと、消す直前に合図が新しくなっていたら（持ち主が復帰した）、そのロックは消さない', async (t) => {
  const workDir = h.makeWorkDir(t);
  h.plantLock(workDir, { requestId: 'sleeping-owner', session: 'tab-X', beatAt: Date.now() - 3500 });
  let resumed = null;
  const restore = h.hookLockStat(workDir, {
    before(count) {
      if (count !== 2) return;
      resumed = { requestId: 'sleeping-owner', session: 'tab-X', beatAt: Date.now() };
      h.writeState(workDir, resumed);
    },
  });
  t.after(restore);

  const queue = h.track(new SpeechQueue('tab-B', workDir).acquire());
  await h.waitFor(() => resumed !== null, 2000, '読み直しまで進む');
  await h.sleep(300);
  restore();
  assert.equal(queue.settled, false);
  assert.deepEqual(h.readState(workDir), resumed, '復帰した持ち主のロックを消してはいけない');

  fs.rmSync(h.stateFile(workDir));
  fs.rmdirSync(h.lockDir(workDir));
  assert.equal(await queue.promise, true);
});

test('読み終わったあとも、自分のタブの latest-* は消さない（同じタブで待っていた古い要求が、古い返事を読まないように）', async (t) => {
  const workDir = h.makeWorkDir(t);
  const reader = new SpeechQueue('tab-A', workDir);
  assert.equal(await reader.acquire(), true);
  const requestId = h.readState(workDir).requestId;
  reader.release();
  reader.cleanupTempFiles();
  assert.equal(fs.readFileSync(h.latestFile(workDir, 'tab-A'), 'utf8'), requestId, '最新の要求の番号が残る');
});

test('24 時間より古い一時ファイルを片付け、新しいものと lock・state は残す', async (t) => {
  const workDir = h.makeWorkDir(t);
  const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  const files = {
    'latest-00000000000000aa': true, // 古い → 消す
    'latest-00000000000000bb.1234': true, // 古い書きかけ → 消す
    'state.tmp.99': true, // 古い書きかけ → 消す
    'latest-00000000000000cc': false, // 新しい → 残す
    'state': false, // 対象外 → 残す
    'notes.txt': false, // 対象外 → 残す
  };
  for (const [name, isOld] of Object.entries(files)) {
    const file = path.join(workDir, name);
    fs.writeFileSync(file, 'x');
    if (isOld || name === 'state' || name === 'notes.txt') fs.utimesSync(file, old, old);
  }
  fs.mkdirSync(h.lockDir(workDir));
  fs.utimesSync(h.lockDir(workDir), old, old);

  new SpeechQueue('tab-A', workDir).cleanupTempFiles();

  for (const [name, isOld] of Object.entries(files)) {
    const removable = isOld && name !== 'state' && name !== 'notes.txt';
    assert.equal(fs.existsSync(path.join(workDir, name)), !removable, name);
  }
  assert.equal(fs.existsSync(h.lockDir(workDir)), true, 'lock');
});

test('ロックを取るまでの間に同じタブの新しい要求に追い越されたら、読まずに終わる', async (t) => {
  const workDir = h.makeWorkDir(t);
  h.plantLock(workDir, { requestId: 'other-owner', session: 'tab-X', beatAt: Date.now() });
  const beat = setInterval(() => h.writeState(workDir, { requestId: 'other-owner', session: 'tab-X', beatAt: Date.now() }), 300);
  t.after(() => clearInterval(beat));

  const waiting = h.track(new SpeechQueue('tab-A', workDir).acquire());
  await h.sleep(300);
  const newer = h.track(new SpeechQueue('tab-A', workDir).acquire());
  assert.equal(await waiting.promise, false);
  assert.equal(newer.settled, false);
  clearInterval(beat);
  fs.rmSync(h.stateFile(workDir));
  fs.rmdirSync(h.lockDir(workDir));
  assert.equal(await newer.promise, true);
});
