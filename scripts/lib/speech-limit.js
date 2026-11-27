/**
 * 1 回の読み上げの時間の上限と、読み上げを止めるときの時間の決まり（OS や声に依存しない）
 *
 *   voiceTimeLimitMs(voice, text)             声と文章から、読み上げの時間の上限を決める
 *   speechTimeLimitMs(text, charsPerSecond)   文字数と速さから、読み上げの時間の上限を決める
 *   STOP_GRACE_MS                             声を止めてから、読み上げが終わるのを待つ上限
 *
 * 声だけが固まって読み上げが終わらないと、ロックが返らず、ほかのタブが待たされ続ける（合図は書かれ続けるため）。
 * そこで、読み終わるまでの時間を文字数と声の速さから見積もり、その LIMIT_FACTOR 倍に LIMIT_EXTRA_MS を足した時間を上限にする。
 * 文章の長さは制限しない。長い文章ほど上限も長くなるので、ふつうに読んでいる文章を途中で切ることはない。
 */
'use strict';

/** 見積もりに掛ける倍率（数字ばかりの文章など、1 文字に時間がかかる文章でも上限に届かないための余裕） */
const LIMIT_FACTOR = 2;
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

module.exports = { voiceTimeLimitMs, speechTimeLimitMs, STOP_GRACE_MS };
