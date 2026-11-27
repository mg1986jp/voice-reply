/**
 * SpeechQueue のテスト: ファイル操作の失敗や行き違いなど、まれな道筋（fs の関数を一時的に差し替えて起こす）
 *   node --test test/*.test.js
 *
 * 差し替えは h.hookFs() に「パス → 何回目の呼び出しで何をするか」の表で渡す。差し替えたら、すぐに t.after() で元に戻す予約をする。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SpeechQueue } = require('../scripts/lib/speech-queue');
const h = require('./helpers');

test('ロックを取った直後に state を書けなかったら、ロックを返して試し直す', async (t) => {
  const workDir = h.makeWorkDir(t);
  // state への置き換え（renameSync の 2 番目の引数）の 1 回目だけ失敗させる
  const restore = h.hookFs('renameSync', { [h.stateFile(workDir)]: { 1: h.throws('EBUSY') } }, { argIndex: 1 });
  t.after(restore);

  const queue = new SpeechQueue('tab-A', workDir);
  assert.equal(await queue.acquire(), true);
  restore();
  assert.equal(restore.counts[h.stateFile(workDir)], 2, '1 回失敗して、2 回目で書けた');
  assert.equal(h.readState(workDir).session, 'tab-A');
  assert.deepEqual(fs.readdirSync(workDir).filter((n) => n.startsWith('state.tmp.')), [], '書きかけが残らない');
  queue.release();
});

test('state を書けないことが続いたら、試し直しの上限であきらめ、ロックを残さない', async (t) => {
  const workDir = h.makeWorkDir(t);
  const restore = h.hookFs('renameSync', { [h.stateFile(workDir)]: { other: h.throws('EBUSY') } }, { argIndex: 1 });
  t.after(restore);

  assert.equal(await new SpeechQueue('tab-A', workDir).acquire(), false);
  restore();
  assert.equal(fs.existsSync(h.lockDir(workDir)), false);
});

test('ロックを取った直後に、同じタブの新しい要求が来ていたら、ロックを譲って読まずに終わる', async (t) => {
  const workDir = h.makeWorkDir(t);
  const takeThenNewerArrives = (real, args) => {
    const result = real(...args);
    fs.writeFileSync(h.latestFile(workDir, 'tab-A'), 'a-newer-request'); // 取った直後に新しい要求が書いた
    return result;
  };
  const restore = h.hookFs('mkdirSync', { [h.lockDir(workDir)]: { 1: takeThenNewerArrives } });
  t.after(restore);

  assert.equal(await new SpeechQueue('tab-A', workDir).acquire(), false);
  restore();
  assert.equal(fs.existsSync(h.lockDir(workDir)), false, 'ロックを譲る');
  assert.equal(fs.existsSync(h.stateFile(workDir)), false);
});

test('待っている間にタブの latest-* が消されても、自分を最新として扱って順番を待ち続ける', async (t) => {
  const workDir = h.makeWorkDir(t);
  const owner = { requestId: 'other-tab', session: 'tab-X' };
  h.plantLock(workDir, { ...owner, beatAt: Date.now() });
  const beat = setInterval(() => h.writeState(workDir, { ...owner, beatAt: Date.now() }), 300);
  t.after(() => clearInterval(beat));

  const waiting = h.track(new SpeechQueue('tab-A', workDir).acquire());
  await h.sleep(300);
  fs.rmSync(h.latestFile(workDir, 'tab-A'));
  await h.sleep(400);
  assert.equal(waiting.settled, false);
  clearInterval(beat);
  fs.rmSync(h.stateFile(workDir));
  fs.rmdirSync(h.lockDir(workDir));
  assert.equal(await waiting.promise, true);
});

test('state が古い版の形式（PID:セッション）に書き換わっていたら、ロックを失ったとして自分の声を止める', async (t) => {
  const workDir = h.makeWorkDir(t);
  const reader = new SpeechQueue('tab-A', workDir);
  assert.equal(await reader.acquire(), true);
  const reasons = [];
  try {
    reader.startWatching((reason) => reasons.push(reason));
    h.writeRawState(workDir, '1234:tab-A');
    await h.waitFor(() => reasons.length > 0, 1500, '気づく');
    assert.deepEqual(reasons, ['lost']);
  } finally {
    reader.release();
  }
  assert.equal(fs.existsSync(h.lockDir(workDir)), true, 'ロックには触らない');
});

test('state が一時的に読めない間は、持ち主はロックを失ったとみなさず、読めるようになったら合図を書き続ける', async (t) => {
  const workDir = h.makeWorkDir(t);
  const reader = new SpeechQueue('tab-A', workDir);
  assert.equal(await reader.acquire(), true);
  const reasons = [];
  try {
    reader.startWatching((reason) => reasons.push(reason));
    const restore = h.hookFs('readFileSync', { [h.stateFile(workDir)]: { other: h.throws('EBUSY') } });
    t.after(restore);
    await h.sleep(1200);
    restore();
    assert.deepEqual(reasons, []);
    const before = h.readState(workDir).beatAt;
    await h.sleep(800);
    assert.ok(h.readState(workDir).beatAt > before, '合図の書き直しが戻る');
    assert.deepEqual(reasons, []);
  } finally {
    reader.release();
  }
});

test('ロックを返すときに state が一時的に読めず、持ち主か確かめられないときは、ロックに触らない', async (t) => {
  const workDir = h.makeWorkDir(t);
  const reader = new SpeechQueue('tab-A', workDir);
  assert.equal(await reader.acquire(), true);
  const owned = h.readState(workDir);

  const restore = h.hookFs('readFileSync', { [h.stateFile(workDir)]: { other: h.throws('EBUSY') } });
  t.after(restore);
  reader.release();
  restore();

  assert.equal(fs.existsSync(h.lockDir(workDir)), true, '確かめられないときは消さない');
  assert.deepEqual(h.readState(workDir), owned);
});

test('合図の古いロックでも、state が一時的に読めない間は片付けず、読めるようになってから片付ける', async (t) => {
  const workDir = h.makeWorkDir(t);
  h.plantLock(workDir, { requestId: 'dead-owner', session: 'tab-X', beatAt: Date.now() - 3500 });
  const restore = h.hookFs('readFileSync', { [h.stateFile(workDir)]: { other: h.throws('EBUSY') } });
  t.after(restore);

  const queue = h.track(new SpeechQueue('tab-B', workDir).acquire());
  await h.sleep(600);
  assert.equal(queue.settled, false);
  assert.equal(h.readState(workDir).requestId, 'dead-owner');
  restore();
  assert.equal(await queue.promise, true);
  assert.equal(h.readState(workDir).session, 'tab-B');
});

test('ロックのフォルダを一時的に調べられない間は片付けず、調べられるようになってから片付ける', async (t) => {
  const workDir = h.makeWorkDir(t);
  h.plantLock(workDir, { requestId: 'dead-owner', session: 'tab-X', beatAt: Date.now() - 3500 });
  const restore = h.hookFs('statSync', { [h.lockDir(workDir)]: { other: h.throws('EPERM') } });
  t.after(restore);

  const queue = h.track(new SpeechQueue('tab-B', workDir).acquire());
  await h.sleep(600);
  assert.equal(queue.settled, false);
  assert.equal(h.readState(workDir).requestId, 'dead-owner');
  restore();
  assert.equal(await queue.promise, true);
});

test('合図が古いと判定したあと、消す直前にロックがなくなっていたら、何も消さずに取り直す', async (t) => {
  const workDir = h.makeWorkDir(t);
  h.plantLock(workDir, { requestId: 'dead-owner', session: 'tab-X', beatAt: Date.now() - 3500 });
  // 1 回目: 様子を調べる（合図が古い） / 2 回目: 消す直前の読み直し。その前に、別のタブが先に片付けたことにする
  const anotherTabCleanedUp = (real, args) => {
    fs.rmSync(h.stateFile(workDir));
    fs.rmdirSync(h.lockDir(workDir));
    return real(...args);
  };
  const restore = h.hookFs('statSync', { [h.lockDir(workDir)]: { 2: anotherTabCleanedUp } });
  t.after(restore);

  const queue = new SpeechQueue('tab-B', workDir);
  assert.equal(await queue.acquire(), true);
  restore();
  assert.equal(h.readState(workDir).session, 'tab-B');
  queue.release();
});

test('ロックを取ろうとして調べる前に返されていたら、すぐに取り直す', async (t) => {
  const workDir = h.makeWorkDir(t);
  h.plantLock(workDir, { requestId: 'other-tab', session: 'tab-X', beatAt: Date.now() });
  // 1 回目の様子を調べる前に（mkdir で EEXIST になったあと）、持ち主が返したことにする
  const ownerReturned = (real, args) => {
    fs.rmSync(h.stateFile(workDir));
    fs.rmdirSync(h.lockDir(workDir));
    return real(...args);
  };
  const restore = h.hookFs('statSync', { [h.lockDir(workDir)]: { 1: ownerReturned } });
  t.after(restore);

  const queue = new SpeechQueue('tab-B', workDir);
  const acquired = queue.acquire();
  try {
    // 待たずに取り直すなら、acquire() が最初に待つより前に state を書き終えている（0.15 秒待つ実装では、まだ書かれていない）
    assert.equal(h.readState(workDir).session, 'tab-B', '待つ前に取り直す');
  } finally {
    assert.equal(await acquired, true);
  }
  restore();
  queue.release();
});

test('片付けで作業フォルダの一覧を読めないときや、ファイルを調べられないときは、何もせずに終わる', async (t) => {
  const workDir = h.makeWorkDir(t);
  const queue = new SpeechQueue('tab-A', workDir);
  const oldFile = path.join(workDir, 'latest-00000000000000aa');
  fs.writeFileSync(oldFile, 'x');
  const old = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(oldFile, old, old);

  const restoreReaddir = h.hookFs('readdirSync', { [workDir]: { other: h.throws('EACCES') } });
  t.after(restoreReaddir);
  assert.doesNotThrow(() => queue.cleanupTempFiles());
  restoreReaddir();
  assert.equal(fs.existsSync(oldFile), true);

  const restoreStat = h.hookFs('statSync', { [oldFile]: { other: h.throws('EPERM') } });
  t.after(restoreStat);
  assert.doesNotThrow(() => queue.cleanupTempFiles());
  restoreStat();
  assert.equal(fs.existsSync(oldFile), true);

  queue.cleanupTempFiles();
  assert.equal(fs.existsSync(oldFile), false, 'ふだんは消える');
});
