/**
 * テスト用の道具（Node の標準モジュールだけ）
 *
 * テストの中に条件分岐の文や三項演算子は書かない。分岐が要るところは、表（オブジェクト）から引く形にする。
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
  rmSync: fs.rmSync,
};
const realStatSync = realFs.statSync;

/** 表から key の値を引く。表にない key のときは fallback を返す */
function lookup(table, key, fallback) {
  return { [key]: fallback, ...table }[key];
}

/** 環境変数の名前が、voice-reply の設定（VOICE_REPLY_ で始まる）か */
const isVoiceReplySetting = (name) => name.startsWith('VOICE_REPLY_');

/**
 * 環境変数から、voice-reply の設定（VOICE_REPLY_ で始まるもの）を除いた写しを返す。
 * テストの子プロセスに渡す環境変数は、これにテストに要る値だけを足す（PC に設定された読み上げの設定を、テストが受け継がないため）
 */
function envWithoutVoiceReply(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isVoiceReplySetting(name)));
}

/** このテストのプロセスの process.env から、voice-reply の設定（VOICE_REPLY_ で始まるもの）を消す（PC の設定は変わらない） */
function clearVoiceReplyEnv() {
  for (const name of Object.keys(process.env).filter(isVoiceReplySetting)) delete process.env[name];
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

/** code を持つ Error（EBUSY など、わざと起こす失敗） */
function fsError(code) {
  const err = new Error(`${code}: injected by test`);
  err.code = code;
  return err;
}

/** hookFs() の表に入れる動き: 本物の fs をそのまま呼ぶ */
const passThrough = (real, args) => real(...args);
/** hookFs() の表に入れる動き: code の失敗を起こす */
const throws = (code) => () => {
  throw fsError(code);
};

/**
 * fs.<name> を一時的に差し替える。
 *
 * plan は「パス → 回数ごとの動き」の表。args[argIndex] が plan にあるパスの呼び出しだけ、そのパスへの何回目の呼び出しかを数え、
 * plan[パス][回数]、なければ plan[パス].other、それもなければ本物の fs を呼ぶ。plan にないパスは、いつも本物に任せる。
 * 動きは (real, args) を受け取る関数で、本物を呼ぶときは real(...args) を返す。
 *
 *   hookFs('renameSync', { [stateFile]: { 1: throws('EBUSY') } }, { argIndex: 1 })   // 1 回目だけ失敗させる
 *   hookFs('readFileSync', { [stateFile]: { other: throws('EBUSY') } })               // 元に戻すまで失敗させる
 *
 * 返り値の関数で元に戻す。その関数の counts に、パスごとの呼び出し回数が入る。
 */
function hookFs(name, plan, { argIndex = 0 } = {}) {
  const real = (...args) => realFs[name].apply(fs, args);
  const counts = {};
  const planned = (target, args) => {
    counts[target] = lookup(counts, target, 0) + 1;
    const calls = plan[target];
    return lookup(calls, counts[target], lookup(calls, 'other', passThrough))(real, args);
  };
  const unplanned = (_target, args) => real(...args);
  const routes = Object.fromEntries(Object.keys(plan).map((target) => [target, planned]));
  fs[name] = (...args) => lookup(routes, args[argIndex], unplanned)(args[argIndex], args);
  const restore = () => {
    fs[name] = realFs[name];
  };
  restore.counts = counts;
  return restore;
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

module.exports = {
  makeWorkDir, lockDir, stateFile, latestFile, readState, writeState, writeRawState, plantLock, plantEmptyLock, lockIdentity,
  waitFor, track, hookFs, throws, passThrough, fsError, lookup, sleep, envWithoutVoiceReply, clearVoiceReplyEnv,
};
