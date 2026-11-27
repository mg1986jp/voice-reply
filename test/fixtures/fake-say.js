/**
 * テスト用の偽の声（node --require で読み込む）
 *
 * Mac として動いていることにして、say の代わりに、声を出さずに次の印を FAKE_VOICE_DIR に書く。
 *   <PID>.started  読み始めた（中身は読む文章）
 *   <PID>.done     最後まで読んだ（FAKE_VOICE_MS ミリ秒かかる）
 *   <PID>.killed   途中で止められた
 *
 * FAKE_SIGTERM_AFTER_START を付けると、読み始めてからそのミリ秒後に、プロセスに SIGTERM が届いたことにする
 * （Windows では外から送るとハンドラーが動かずに終わるため、process.emit で起こす）。
 *
 * 読み上げの時間の決まり（scripts/lib/speech-limit.js）を、speak.js が読み込む前に差し替える（環境変数があるときだけ）:
 *   FAKE_TIME_LIMIT_MS  読み上げの時間の上限（声の速さによらず、このミリ秒にする）
 *   FAKE_STOP_GRACE_MS  声を止めてから、読み上げが終わるのを待つ上限
 *
 * FAKE_KILL_IGNORED を付けると、止めても声が終わらないことにする（止められたら <PID>.kill-ignored に止められた回数を書き、読み続ける）。
 * FAKE_VOICE_WITHOUT_SPEED を付けると、速さを見積もれない声（charsPerSecond() を持たない声）にする。
 *
 * プロセスが終わるときに、setTimeout() で作ったタイマーの長さ（ミリ秒）を、作った順に JSON の配列で <PID>.timers に書く。
 *
 * 止めるのは一度だけになる（読み終わったあとや、止めたあとは、声の側の kill() が子プロセスの状態を見て呼ばない）。
 */
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');
const speechLimit = require('../../scripts/lib/speech-limit');

Object.defineProperty(process, 'platform', { value: 'darwin' });
const dir = process.env.FAKE_VOICE_DIR;
const duration = Number(process.env.FAKE_VOICE_MS || 0);
const mark = (name, content = '') => fs.writeFileSync(path.join(dir, `${process.pid}.${name}`), content);

// 読み始めたあと SIGTERM を起こすかどうか（環境変数があるときだけ）
const afterStart = {
  true: () => setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), Number(process.env.FAKE_SIGTERM_AFTER_START)),
  false: () => {},
}[String('FAKE_SIGTERM_AFTER_START' in process.env)];

// 読み上げの時間の決まりの差し替え: [環境変数, 差し替える値を作る関数]（環境変数があるものだけ差し替える）
const SPEECH_LIMIT_OVERRIDES = [
  ['FAKE_TIME_LIMIT_MS', (ms) => ({ voiceTimeLimitMs: () => ms })],
  ['FAKE_STOP_GRACE_MS', (ms) => ({ STOP_GRACE_MS: ms })],
];
for (const [name, override] of SPEECH_LIMIT_OVERRIDES.filter(([envName]) => envName in process.env)) {
  Object.assign(speechLimit, override(Number(process.env[name])));
}

// setTimeout() で作ったタイマーの長さを記録し、終わるときに書く（process.exit() で終わるときも書く）
const realSetTimeout = globalThis.setTimeout;
const timerDelays = [];
globalThis.setTimeout = (callback, delay, ...args) => {
  timerDelays.push(delay);
  return realSetTimeout(callback, delay, ...args);
};
process.on('exit', () => mark('timers', JSON.stringify(timerDelays)));

const killIgnored = String('FAKE_KILL_IGNORED' in process.env);
let ignoredKills = 0;

childProcess.spawn = function fakeSpawn() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  let timer = null;
  const stop = () => {
    clearTimeout(timer);
    child.signalCode = 'SIGKILL';
    mark('killed');
    child.emit('close', null, 'SIGKILL');
  };
  const ignore = () => {
    ignoredKills += 1;
    mark('kill-ignored', String(ignoredKills));
  };
  child.kill = { true: ignore, false: stop }[killIgnored];
  const chunks = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
    final(callback) {
      mark('started', Buffer.concat(chunks).toString('utf8'));
      callback();
      afterStart();
      timer = setTimeout(() => {
        child.exitCode = 0;
        mark('done');
        child.emit('close', 0, null);
      }, duration);
    },
  });
  return child;
};

// 速さを見積もれない声にする（環境変数があるときだけ）。speak.js は voices/index.js を通して mac-say.create() を呼ぶ。
// mac-say.js は読み込んだ時点で spawn を受け取るので、spawn を偽物に差し替えたあとに読み込む
const macSay = require('../../scripts/voices/mac-say');
const createMacSay = macSay.create;
const withoutSpeed = (env) => {
  const voice = createMacSay(env);
  return { speak: (text) => voice.speak(text), kill: () => voice.kill() };
};
macSay.create = { true: withoutSpeed, false: createMacSay }[String('FAKE_VOICE_WITHOUT_SPEED' in process.env)];
