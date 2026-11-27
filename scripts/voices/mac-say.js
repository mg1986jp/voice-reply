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

/**
 * -r 260（初期値）のときに、1 秒に読む文字数。
 * Kyoko で本物の返事の要約を測ると約 8.3 文字（一番遅いもので 7.78 文字）だった。上限を長めに見積もる向きに、少し小さい 8 にする。
 */
const CHARS_PER_SECOND_AT_DEFAULT_RATE = 8;
/**
 * これより大きい -r を指定しても、声は速くならない（Kyoko で測ると、-r 200〜700 では速さが -r にほぼ比例し、770 より上は頭打ちだった）。
 * 見積もりもここで頭打ちにする。頭打ちにしないと、770 より上の -r で実際より速く見積もり、上限が短くなりすぎて、ふつうの読み上げを途中で止めてしまう。
 * なお -r 200 より下は、設定ほど遅くならない（実際は見積もりより速く読み終わる）ので、比例のまま見積もっても上限が短くなる向きにはずれない。
 */
const MAX_EFFECTIVE_RATE = 770;

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

  speak(text, { onSegment = () => {} } = {}) {
    // 全体を1つの区切りとして読む（読み上げの時間の上限は、全体に1つ）
    onSegment(text, this);
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

  /**
   * 1 秒に読む文字数（速さの設定から見積もる）。-r にほぼ比例し、MAX_EFFECTIVE_RATE で頭打ちにする。
   * Kyoko で測った値なので、CLAUDE_SAY_VOICE でほかの声にしたときは、実際の速さとずれることがある。
   */
  charsPerSecond() {
    return (CHARS_PER_SECOND_AT_DEFAULT_RATE * Math.min(this.#rate, MAX_EFFECTIVE_RATE)) / DEFAULT_RATE;
  }
}

/** 環境変数の設定から作る */
function create(env) {
  return new MacSay(env.CLAUDE_SAY_VOICE || DEFAULT_VOICE, parseRate(env.CLAUDE_SAY_RATE));
}

module.exports = { create };
