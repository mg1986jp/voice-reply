/**
 * 声（読み上げエンジン）の選択
 *
 * 声ごとに1つのファイルに分けている。どのファイルも create(env) で次の2つを持つものを返す:
 *   speak(text): Promise<void>  読み終わったら（失敗しても）resolve する
 *   kill(): void                読み上げを即座に止める（シグナル受信時に使う）
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
