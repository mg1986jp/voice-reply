/**
 * テスト用の道具（Node の標準モジュールだけ）
 */
'use strict';

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

/** state を書く（本物と同じく、一時ファイルに書いてから置き換える）。文字列を渡すと、そのまま書く */
function writeState(workDir, state) {
  const tmp = `${stateFile(workDir)}.test-tmp`;
  realFs.writeFileSync(tmp, typeof state === 'string' ? state : JSON.stringify(state));
  realFs.renameSync(tmp, stateFile(workDir));
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

/** ほかのタブが持っているロックを置く。state を省くと、state のないロックになる */
function plantLock(workDir, state) {
  realFs.mkdirSync(lockDir(workDir));
  if (state) writeState(workDir, state);
}

/** ロックのフォルダの身元（作り直されたかを見分ける） */
function lockIdentity(workDir) {
  const stat = realStatSync(lockDir(workDir), { bigint: true });
  return `${stat.ino}:${stat.birthtimeNs}`;
}

async function waitFor(condition, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (condition()) return;
    await sleep(20);
  }
  throw new Error(`timed out: ${label}`);
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
 * を呼ぶ。返り値の関数で元に戻す。
 */
function hookLockStat(workDir, { before = () => {}, after = () => {} }) {
  let count = 0;
  fs.statSync = function patchedStatSync(target, ...rest) {
    if (target !== lockDir(workDir)) return realStatSync.call(this, target, ...rest);
    count += 1;
    before(count);
    const result = realStatSync.call(this, target, ...rest);
    after(count, result);
    return result;
  };
  return () => {
    fs.statSync = realStatSync;
  };
}

module.exports = {
  makeWorkDir, lockDir, stateFile, latestFile, readState, writeState, plantLock, lockIdentity, waitFor, track, hookLockStat, patchFs, fsError, sleep,
};
