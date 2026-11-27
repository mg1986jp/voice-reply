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
  const newer = new SpeechQueue('tab-A', workDir);
  // アサーションが失敗しても、見張りを止めてロックを返してから終わる（作業フォルダを消す前に）
  try {
    const readerRequest = h.readState(workDir).requestId;
    const reasons = [];
    // 声を止めると読み上げが終わり、release() が呼ばれる流れをまねる
    reader.startWatching((reason) => {
      reasons.push(reason);
      setImmediate(() => reader.release());
    });

    const started = Date.now();
    assert.equal(await newer.acquire(), true);
    const elapsed = Date.now() - started;

    assert.deepEqual(reasons, ['replaced']);
    assert.ok(elapsed < 1000, `差し替えに ${elapsed}ms かかった`);
    const state = h.readState(workDir);
    assert.equal(state.session, 'tab-A');
    assert.notEqual(state.requestId, readerRequest);
  } finally {
    reader.release();
    newer.release();
  }
  assert.equal(fs.existsSync(h.lockDir(workDir)), false);
});

test('別のタブは、ロックが返されるまで順番を待ち、返されたら 0.15 秒の間隔ですぐに取る', async (t) => {
  const workDir = h.makeWorkDir(t);
  const reader = new SpeechQueue('tab-A', workDir);
  assert.equal(await reader.acquire(), true);
  // 待っている側がロックを調べた回数を数える（数えるだけで、いつも本物を呼ぶ）
  const restore = h.hookFs('statSync', { [h.lockDir(workDir)]: {} });
  t.after(restore);
  const checks = () => h.lookup(restore.counts, h.lockDir(workDir), 0);
  const otherQueue = new SpeechQueue('tab-B', workDir);
  const other = h.track(otherQueue.acquire());
  // アサーションが失敗しても、見張りを止め、待っている取得を回収してから終わる（作業フォルダを消す前に）
  try {
    reader.startWatching(() => assert.fail('別のタブの要求で止めてはいけない'));
    // 5 回調べる間に（0.15 秒ごとなので 0.6 秒以上）、持ち主は合図を書き直す
    await h.waitFor(() => checks() >= 5, 3000, '待っている側がロックを 5 回調べる');
    assert.equal(other.settled, false, '持ち主が読んでいる間は、何回調べても待つ');
    assert.equal(h.readState(workDir).session, 'tab-A');

    const releasedAt = Date.now();
    reader.release();
    assert.equal(await other.promise, true);
    const gap = Date.now() - releasedAt;
    assert.ok(gap < 400, `ロックが返されてから取るまでに ${gap}ms かかった`);
    assert.equal(h.readState(workDir).session, 'tab-B');
  } finally {
    reader.release();
    try {
      await other.promise;
    } finally {
      otherQueue.release();
    }
  }
});

test('読んでいる間は、0.5 秒ごとに合図（beatAt）を書き直す', async (t) => {
  const workDir = h.makeWorkDir(t);
  const reader = new SpeechQueue('tab-A', workDir);
  assert.equal(await reader.acquire(), true);
  try {
    reader.startWatching(() => {});
    const first = h.readState(workDir).beatAt;
    await h.sleep(1300);
    const later = h.readState(workDir).beatAt;
    assert.ok(later - first >= 900, `合図が ${later - first}ms しか進んでいない`);
  } finally {
    reader.release();
  }
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
  // 合図が途切れた間に片付けられ、ほかのタブに取られたことにする
  const taken = { requestId: 'other-tab-request', session: 'tab-B', beatAt: Date.now() };
  try {
    reader.startWatching((reason) => reasons.push(reason));
    h.writeState(workDir, taken);
    await h.waitFor(() => reasons.length > 0, 1500, '取られたことに気づく');
    assert.deepEqual(reasons, ['lost']);
  } finally {
    reader.release();
  }
  assert.equal(fs.existsSync(h.lockDir(workDir)), true, '相手のロックを消してはいけない');
  assert.deepEqual(h.readState(workDir), taken, '相手の state を書き換えてはいけない');
});

test('合図を書いているときに、state がなくなっていたら、ロックを失ったとして自分の声を止め、ロックに触らない', async (t) => {
  const workDir = h.makeWorkDir(t);
  const reader = new SpeechQueue('tab-A', workDir);
  assert.equal(await reader.acquire(), true);
  const reasons = [];
  try {
    reader.startWatching((reason) => reasons.push(reason));
    // 片付けられたあと、ほかのタブがロックを取り直して、まだ state を書いていないところ
    fs.rmSync(h.stateFile(workDir));
    await h.waitFor(() => reasons.length > 0, 1500, 'state がなくなったことに気づく');
    assert.deepEqual(reasons, ['lost']);
  } finally {
    reader.release();
  }
  assert.equal(fs.existsSync(h.lockDir(workDir)), true, 'ほかのタブのロックかもしれないので消さない');
  assert.equal(fs.existsSync(h.stateFile(workDir)), false);
});

test('合図が古いと判定したあと、消す直前に state がなくなっていたら、そのロックは消さない', async (t) => {
  const workDir = h.makeWorkDir(t);
  h.plantLock(workDir, { requestId: 'dead-owner', session: 'tab-X', beatAt: Date.now() - 3500 });
  let recreated = null;
  // 1 回目: 様子を調べる（合図が古い） / 2 回目: 消す直前の読み直し。その前に、ほかのタブが片付けて取り直し、まだ state を書いていないことにする
  const anotherTabRetook = (real, args) => {
    fs.rmSync(h.stateFile(workDir));
    fs.rmdirSync(h.lockDir(workDir));
    fs.mkdirSync(h.lockDir(workDir));
    recreated = h.lockIdentity(workDir);
    return real(...args);
  };
  const restore = h.hookFs('statSync', { [h.lockDir(workDir)]: { 2: anotherTabRetook } });
  t.after(restore);
  const checks = () => h.lookup(restore.counts, h.lockDir(workDir), 0);

  const queue = h.track(new SpeechQueue('tab-B', workDir).acquire());
  await h.waitFor(() => recreated !== null, 2000, '読み直しまで進む');
  const seen = checks();
  await h.waitFor(() => checks() >= seen + 3, 2000, '取り直されたロックを、さらに 3 回調べる');
  restore();
  assert.equal(queue.settled, false);
  assert.equal(h.lockIdentity(workDir), recreated, '取り直されたロックを消してはいけない');

  fs.rmdirSync(h.lockDir(workDir)); // 取り直したタブが返したことにして、待っている要求を終わらせる
  assert.equal(await queue.promise, true);
});

test('state のない古いロックは、消す直前にフォルダが作り直されていたら片付けない', async (t) => {
  const workDir = h.makeWorkDir(t);
  h.plantEmptyLock(workDir);
  let recreated = null;
  // 1 回目: 様子を調べる。このときだけ、6 秒前に作られたフォルダに見せる（5 秒の猶予が切れた state のないロックと判定させる）
  const looksSixSecondsOld = (real, args) => ({ ...real(...args), ctimeMs: BigInt(Date.now() - 6000) });
  // 2 回目: 消す直前の読み直し。その前に、ほかのタブが片付けて取り直し、まだ state を書いていないことにする
  const anotherTabRetook = (real, args) => {
    fs.rmdirSync(h.lockDir(workDir));
    fs.mkdirSync(h.lockDir(workDir));
    recreated = h.lockIdentity(workDir);
    return real(...args);
  };
  const restore = h.hookFs('statSync', { [h.lockDir(workDir)]: { 1: looksSixSecondsOld, 2: anotherTabRetook } });
  t.after(restore);
  const checks = () => h.lookup(restore.counts, h.lockDir(workDir), 0);

  const queue = h.track(new SpeechQueue('tab-B', workDir).acquire());
  await h.waitFor(() => recreated !== null, 2000, '消す直前の読み直しまで進む');
  const seen = checks();
  await h.waitFor(() => checks() >= seen + 3, 2000, '作り直されたロックを、さらに 3 回調べる');
  restore();
  assert.equal(queue.settled, false);
  assert.equal(h.lockIdentity(workDir), recreated, '作り直されたロックを消してはいけない');

  fs.rmdirSync(h.lockDir(workDir)); // 取り直したタブが返したことにして、待っている要求を終わらせる
  assert.equal(await queue.promise, true);
});

test('合図が古いと判定したあと、消す直前に合図が新しくなっていたら（持ち主が復帰した）、そのロックは消さない', async (t) => {
  const workDir = h.makeWorkDir(t);
  h.plantLock(workDir, { requestId: 'sleeping-owner', session: 'tab-X', beatAt: Date.now() - 3500 });
  let resumed = null;
  // 2 回目（消す直前の読み直し）の前に、持ち主が復帰して合図を書き直したことにする
  const ownerResumed = (real, args) => {
    resumed = { requestId: 'sleeping-owner', session: 'tab-X', beatAt: Date.now() };
    h.writeState(workDir, resumed);
    return real(...args);
  };
  const restore = h.hookFs('statSync', { [h.lockDir(workDir)]: { 2: ownerResumed } });
  t.after(restore);
  const checks = () => h.lookup(restore.counts, h.lockDir(workDir), 0);

  const queue = h.track(new SpeechQueue('tab-B', workDir).acquire());
  await h.waitFor(() => resumed !== null, 2000, '読み直しまで進む');
  const seen = checks();
  await h.waitFor(() => checks() >= seen + 3, 2000, '復帰した持ち主のロックを、さらに 3 回調べる');
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
  const now = Date.now() / 1000;
  const old = now - 25 * 60 * 60;
  // [ファイル名, 更新時刻, 片付けのあとに残るか]
  const cases = [
    ['latest-00000000000000aa', old, false], // 古い latest → 消す
    ['latest-00000000000000bb.1234', old, false], // 古い書きかけ → 消す
    ['state.tmp.99', old, false], // 古い書きかけ → 消す
    ['latest-00000000000000cc', now, true], // 新しい → 残す
    ['state', old, true], // 対象外 → 古くても残す
    ['notes.txt', old, true], // 対象外 → 古くても残す
  ];
  for (const [name, mtime] of cases) {
    const file = path.join(workDir, name);
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, mtime, mtime);
  }
  fs.mkdirSync(h.lockDir(workDir));
  fs.utimesSync(h.lockDir(workDir), old, old);

  new SpeechQueue('tab-A', workDir).cleanupTempFiles();

  for (const [name, , kept] of cases) {
    assert.equal(fs.existsSync(path.join(workDir, name)), kept, name);
  }
  assert.equal(fs.existsSync(h.lockDir(workDir)), true, 'lock は古くても残す');
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
