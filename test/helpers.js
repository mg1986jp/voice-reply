/**
 * テスト用の道具（Node の標準モジュールだけ）
 *
 * テストの中に分岐（if/else、三項演算子）は書かない。分岐が要るところは、表（オブジェクト）から引く形にする。
 */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

// fs の関数を差し替えている間も、テストの道具は本物を使う（差し替えた中から呼ぶと、自分を呼び続けたり、わざと起こした失敗に巻き込まれたりするため）
const realFs = {
  statSync: fs.statSync,
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  renameSync: fs.renameSync,
  mkdirSync: fs.mkdirSync,
  readdirSync: fs.readdirSync,
};
const realStatSync = realFs.statSync;

/** 表から key の値を引く。表にない key のときは fallback を返す */
function lookup(table, key, fallback) {
  return { [key]: fallback, ...table }[key];
}

/** テストごとの作業フォルダを作り、終わったら消す */
function makeWorkDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-reply-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const lockDir = (workDir) => path.join(workDir, 'lock');
const stateFile = (workDir) => path.join(workDir, 'state');
const latestFile = (workDir, session) =>
  path.join(workDir, `latest-${crypto.createHash('sha256').update(session).digest('hex').slice(0, 16)}`);

function readState(workDir) {
  return JSON.parse(realFs.readFileSync(stateFile(workDir), 'utf8'));
}

/** state に文字列をそのまま書く（本物と同じく、一時ファイルに書いてから置き換える） */
function writeRawState(workDir, text) {
  const tmp = `${stateFile(workDir)}.test-tmp`;
  realFs.writeFileSync(tmp, text);
  realFs.renameSync(tmp, stateFile(workDir));
}

/** state を書く */
function writeState(workDir, state) {
  writeRawState(workDir, JSON.stringify(state));
}

/**
 * fs の関数を一時的に差し替える。impl(real, args) の返り値を返し、例外を投げればそれが起きたことになる。
 * 返り値の関数で元に戻す。
 */
function patchFs(name, impl) {
  const real = realFs[name];
  fs[name] = function patched(...args) {
    return impl((...a) => real.apply(fs, a), args);
  };
  return () => {
    fs[name] = real;
  };
}

/** code を持つ Error（EBUSY など、わざと起こす失敗） */
function fsError(code) {
  const err = new Error(`${code}: injected by test`);
  err.code = code;
  return err;
}

/** state のないロックを置く（ロックを作ってから state を書く前に落ちた持ち主のもの、など） */
function plantEmptyLock(workDir) {
  realFs.mkdirSync(lockDir(workDir));
}

/** ほかのタブが持っているロックを置く */
function plantLock(workDir, state) {
  plantEmptyLock(workDir);
  writeState(workDir, state);
}

/** ロックのフォルダの身元（作り直されたかを見分ける） */
function lockIdentity(workDir) {
  const stat = realStatSync(lockDir(workDir), { bigint: true });
  return `${stat.ino}:${stat.birthtimeNs}`;
}

/** condition() が true になるまで待つ。timeoutMs を過ぎても true にならなければ失敗にする */
async function waitFor(condition, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (!condition() && Date.now() < end) await sleep(20);
  assert.ok(condition(), `timed out: ${label}`);
}

/** promise がまだ終わっていないかを調べられるようにする */
function track(promise) {
  const tracked = { settled: false, value: undefined };
  tracked.promise = promise.then((value) => {
    tracked.settled = true;
    tracked.value = value;
    return value;
  });
  return tracked;
}

/**
 * fs.statSync を一時的に差し替える。ロックのフォルダが調べられるたびに、
 *   before(回数)        調べる直前
 *   after(回数, 結果)    調べた直後
 * を呼ぶ。ほかのパスは本物の statSync に任せる。返り値の関数で元に戻す。
 */
function hookLockStat(workDir, { before = () => {}, after = () => {} }) {
  let count = 0;
  const hooked = (...args) => {
    count += 1;
    before(count);
    const result = realStatSync.apply(fs, args);
    after(count, result);
    return result;
  };
  const plain = (...args) => realStatSync.apply(fs, args);
  fs.statSync = (...args) => lookup({ [lockDir(workDir)]: hooked }, args[0], plain)(...args);
  return () => {
    fs.statSync = realStatSync;
  };
}

module.exports = {
  makeWorkDir, lockDir, stateFile, latestFile, readState, writeState, writeRawState, plantLock, plantEmptyLock, lockIdentity,
  waitFor, track, hookLockStat, patchFs, fsError, lookup, sleep,
};
