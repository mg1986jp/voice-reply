/**
 * テスト用の偽の child_process.spawn（テストのファイルの中から install() で差し替える）
 *
 * 本物の子プロセスを起動しないので、声も音も出ない。
 * spawn を読み込んだ時点で受け取るモジュール（scripts/lib/wav-player.js、scripts/voices/ の声）は、install() のあとに読み込む。
 *
 *   const fake = install()
 *     fake.spawned           作った FakeChild（作った順）
 *     fake.onSpawn = (child) => { ... }   spawn されるたびに呼ぶ。偽の子プロセスの動きをここで決める
 *
 * FakeChild:
 *   command, args, options  spawn に渡されたもの
 *   input                   標準入力に書かれた文字列（書かれた順につなげたもの）
 *   kills                   kill() に渡されたシグナル（引数なしは SIGTERM）
 *   stdout                  ここに書くと、spawn した側に、子プロセスの標準出力として届く
 *   finish(code, signal)    終わったことにする（exitCode と signalCode を決めて close を出す）
 *   イベント input          標準入力に書かれるたびに、書かれた文字列で出す
 *   イベント input-end      標準入力が閉じられたときに出す
 *
 * spawn した側が 'close' などを受け取れるのは spawn() から戻ったあとなので、onSpawn の中ですぐに終わらせるときは setImmediate() を使う。
 */
'use strict';

const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

class FakeChild extends EventEmitter {
  constructor(command, args, options) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
    this.exitCode = null;
    this.signalCode = null;
    this.input = '';
    this.kills = [];
    this.stdout = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const text = String(chunk);
        this.input += text;
        callback();
        this.emit('input', text);
      },
      final: (callback) => {
        callback();
        this.emit('input-end');
      },
    });
  }

  kill(signal = 'SIGTERM') {
    this.kills.push(signal);
    this.finish(null, signal);
    return true;
  }

  finish(code, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }
}

/** child_process.spawn を偽物に差し替える */
function install() {
  const fake = { spawned: [], onSpawn: () => {} };
  childProcess.spawn = (command, args, options) => {
    const child = new FakeChild(command, args, options);
    fake.spawned.push(child);
    fake.onSpawn(child);
    return child;
  };
  return fake;
}

module.exports = { install };
