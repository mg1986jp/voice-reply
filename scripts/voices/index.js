/**
 * 声（読み上げエンジン）の選択
 *
 * 声ごとに1つのファイルに分けている。どのファイルも create(env) で次の2つを持つものを返す:
 *   speak(text): Promise<void>  読み終わったら（失敗しても）resolve する
 *   kill(): void                読み上げを即座に止める（自分の子プロセスだけを止める。シグナルを受けたとき、
 *                               同じタブの新しい返事が来たとき、ロックを失ったとき、時間の上限を超えたときに使う）
 * 次の1つは、持っていれば使う:
 *   charsPerSecond(): number    1 秒に読む文字数（声と速さの設定から見積もる）。読み上げの時間の上限を決めるのに使う。
 *                               持たない声では、時間の上限を設けない
 *
 * 声を足すときは、このフォルダにファイルを足して、getVoice() で選べるようにする。
 */
'use strict';

const macSay = require('./mac-say');
const windowsSapi = require('./windows-sapi');

/** 実行中の OS に合う声を返す。対応していない OS では null。 */
function getVoice(env = process.env) {
  switch (process.platform) {
    case 'darwin':
      return macSay.create(env);
    case 'win32':
      return windowsSapi.create(env);
    default:
      return null;
  }
}

module.exports = { getVoice };
