/**
 * 読み上げの時間の上限と、読み上げを止めるときの時間の決まり（OS や声に依存しない）
 *
 *   voiceTimeLimitMs(voice, text)             声と文章から、読み上げの時間の上限を決める
 *   speechTimeLimitMs(text, charsPerSecond)   文字数と速さから、読み上げの時間の上限を決める
 *   SpeechLimitTimer                          上限を見張るタイマー。声が読む区切りごとに測り直す
 *   STOP_GRACE_MS                             声を止めてから、読み上げが終わるのを待つ上限
 *
 * 声だけが固まって読み上げが終わらないと、ロックが返らず、ほかのタブが待たされ続ける（合図は書かれ続けるため）。
 * そこで、読み終わるまでの時間を文字数と声の速さから見積もり、その LIMIT_FACTOR 倍に LIMIT_EXTRA_MS を足した時間を上限にする。
 * 上限は、声が読む区切りごとに決める。OS の声は全体が1つの区切り、AivisSpeech は文ごとの区切り
 * （文ごとにすると、音声を作る時間が読む時間より長い PC でも、固まった文にすぐ気づける）。
 * 文章の長さは制限しない。長い区切りほど上限も長くなる。
 */
'use strict';

/**
 * 見積もりに掛ける倍率（数字ばかりの文章など、1 文字に時間がかかる文章でも上限に届かないための余裕）。
 * 数字ばかりの文章は、Windows（Haruka）で見積もりの約 1.71 倍、Mac（Kyoko）で約 2.04 倍かかった。
 * 2 倍では Mac で上限を超えるので、どちらにも同じだけの余裕が残る 2.5 倍にそろえる。
 */
const LIMIT_FACTOR = 2.5;
/** 見積もりに足す時間（声の起動など、文章の長さによらずにかかる時間の余裕） */
const LIMIT_EXTRA_MS = 30 * 1000;
/** setTimeout() に渡せる一番長い時間。これを超えると、すぐに呼ばれてしまう */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * 声を止めてから、読み上げ（声の子プロセス）が終わるのを待つ上限。
 * ふつうは止めるとすぐに終わる（Mac は SIGKILL、Windows は TerminateProcess で強制的に終わらせる）。
 * それでも終わらないときは、待つのをやめて、ロックを返して終わる（ほかのタブを待たせ続けないため）。
 */
const STOP_GRACE_MS = 2000;

/** 読む文字数。絵文字などのサロゲートペアも 1 文字と数え、空白と改行も数える（速さを測ったときと同じ数え方） */
function countChars(text) {
  return [...text].length;
}

/**
 * 文字数と速さから、読み上げの時間の上限（ミリ秒）を決める
 * @param {string} text            読む文章
 * @param {number} charsPerSecond  声が 1 秒に読む文字数
 */
function speechTimeLimitMs(text, charsPerSecond) {
  const estimateMs = (countChars(text) / charsPerSecond) * 1000;
  return Math.min(Math.ceil(estimateMs * LIMIT_FACTOR + LIMIT_EXTRA_MS), MAX_TIMER_MS);
}

/**
 * 声と文章から、読み上げの時間の上限（ミリ秒）を決める。
 * 速さを見積もれない声（charsPerSecond() を持たない声）では null を返す（上限を設けない）。
 */
function voiceTimeLimitMs(voice, text) {
  if (typeof voice.charsPerSecond !== 'function') return null;
  return speechTimeLimitMs(text, voice.charsPerSecond());
}

/**
 * 読み上げの時間の上限を見張るタイマー。声が新しい区切りに取りかかるたびに restart() で測り直し、
 * 1 つの区切りが上限を超えたら onExpire() を呼ぶ（speak.js は自分の声を止める）。
 */
class SpeechLimitTimer {
  #onExpire;
  #timer = null;

  /** @param {() => void} onExpire 上限を超えたときに呼ぶ */
  constructor(onExpire) {
    this.#onExpire = onExpire;
  }

  /** 新しい区切りの上限（ミリ秒）で測り直す。null なら測らない（速さを見積もれない声） */
  restart(limitMs) {
    this.clear();
    if (limitMs !== null) this.#timer = setTimeout(this.#onExpire, limitMs);
  }

  clear() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}

module.exports = { voiceTimeLimitMs, speechTimeLimitMs, SpeechLimitTimer, STOP_GRACE_MS };
