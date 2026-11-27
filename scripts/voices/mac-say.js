/**
 * 声: macOS の say コマンド
 *
 * 設定（環境変数）:
 *   CLAUDE_SAY_VOICE  声の名前（初期値: Kyoko）
 *   CLAUDE_SAY_RATE   速さ（say -r の値。正の整数、初期値 260）
 */
'use strict';

const { spawn } = require('node:child_process');

const DEFAULT_VOICE = 'Kyoko';
const DEFAULT_RATE = 260; // say -r の値（1分あたりの語数）

/** say -r に渡す速さ。正の整数でなければ初期値を使う。 */
function parseRate(value) {
  const rate = Number.parseInt(value ?? '', 10);
  return Number.isInteger(rate) && rate > 0 ? rate : DEFAULT_RATE;
}

/** macOS の say コマンドで読み上げる */
class MacSay {
  #voice;
  #rate;
  #proc = null;

  constructor(voice, rate) {
    this.#voice = voice;
    this.#rate = rate;
  }

  speak(text) {
    return new Promise((resolve) => {
      this.#proc = spawn('say', ['-v', this.#voice, '-r', String(this.#rate)], {
        stdio: ['pipe', 'inherit', 'inherit'],
      });
      this.#proc.on('error', () => resolve());
      this.#proc.on('close', () => resolve());
      this.#proc.stdin.on('error', () => {}); // say が先に終了した場合の EPIPE を無視する
      this.#proc.stdin.end(text, 'utf8');
    });
  }

  kill() {
    if (this.#proc && this.#proc.exitCode === null && this.#proc.signalCode === null) {
      this.#proc.kill('SIGKILL');
    }
  }
}

/** 環境変数の設定から作る */
function create(env) {
  return new MacSay(env.CLAUDE_SAY_VOICE || DEFAULT_VOICE, parseRate(env.CLAUDE_SAY_RATE));
}

module.exports = { create };
