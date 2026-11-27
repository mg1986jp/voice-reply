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
 */
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Writable } = require('node:stream');

Object.defineProperty(process, 'platform', { value: 'darwin' });
const dir = process.env.FAKE_VOICE_DIR;
const duration = Number(process.env.FAKE_VOICE_MS || 0);
const mark = (name, content = '') => fs.writeFileSync(path.join(dir, `${process.pid}.${name}`), content);

childProcess.spawn = function fakeSpawn() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  let timer = null;
  child.kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    clearTimeout(timer);
    child.signalCode = 'SIGKILL';
    mark('killed');
    child.emit('close', null, 'SIGKILL');
  };
  const chunks = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
    final(callback) {
      mark('started', Buffer.concat(chunks).toString('utf8'));
      callback();
      if (process.env.FAKE_SIGTERM_AFTER_START) {
        setTimeout(() => process.emit('SIGTERM', 'SIGTERM'), Number(process.env.FAKE_SIGTERM_AFTER_START));
      }
      timer = setTimeout(() => {
        child.exitCode = 0;
        mark('done');
        child.emit('close', 0, null);
      }, duration);
    },
  });
  return child;
};
