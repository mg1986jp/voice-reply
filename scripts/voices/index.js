/**
 * 声（読み上げエンジン）の選択
 *
 * 声ごとに1つのファイルに分けている。どのファイルも create(env) で次の2つを持つものを返す:
 *   speak(text, { onSegment }): Promise  読み終わったら（失敗しても）resolve する。
 *                               読む区切りごとに、その区切りに取りかかる前に onSegment(区切りの文章, その区切りを読む声) を呼ぶ
 *                               （OS の声は全体を1つの区切りにし、AivisSpeech は文ごとに区切る。
 *                                speak.js は、区切りごとに読み上げの時間の上限を測り直す）
 *   kill(): void                読み上げを即座に止める（自分の子プロセスだけを止める。シグナルを受けたとき、
 *                               同じタブの新しい返事が来たとき、ロックを失ったとき、時間の上限を超えたときに使う）
 * 次の1つは、持っていれば使う:
 *   charsPerSecond(): number    1 秒に読む文字数（声と速さの設定から見積もる）。読み上げの時間の上限を決めるのに使う。
 *                               持たない声では、時間の上限を設けない
 *
 * どの声で読むか（環境変数 VOICE_REPLY_ENGINE）:
 *   auto（初期値）  AivisSpeech Engine が短い時間で応答すれば AivisSpeech、応答しなければ OS の声。
 *                   AivisSpeech が 1 文目を鳴らし始める前に失敗したら、OS の声で全部読む。読んでいる途中で失敗したら、そこでやめる
 *   aivisspeech     いつも AivisSpeech（エンジンが動いているかを確かめず、失敗しても OS の声に切り替えない）
 *   os              いつも OS の声（Mac は say、Windows は SAPI の声）
 *   これ以外の値は auto として扱う。
 *
 * 声を足すときは、このフォルダにファイルを足して、chooseVoice() で選べるようにする。
 */
'use strict';

const macSay = require('./mac-say');
const windowsSapi = require('./windows-sapi');
const aivisspeech = require('./aivisspeech');

const ENGINES = ['auto', 'aivisspeech', 'os'];

/** VOICE_REPLY_ENGINE の値。決まりに合わなければ auto */
function parseEngine(value) {
  const engine = (value ?? '').trim().toLowerCase();
  return ENGINES.includes(engine) ? engine : 'auto';
}

/**
 * AivisSpeech で読み、1 文目を鳴らし始める前に失敗したら、OS の声で全部読み直す。
 * 読んでいる途中で失敗したときは、読み直さずにそこでやめる（同じところを2回聞かせないため）。
 *
 * kill() は、そのときに読んでいる方の声を止める。AivisSpeech を止めたあとは、AivisSpeech の結果は STOPPED になるので、
 * OS の声に切り替わることはない。OS の声に切り替えるときは、切り替えと読み始めを続けて行う（その間に kill() は入らない）。
 */
class AivisSpeechWithFallback {
  #aivis;
  #osVoice;
  #current;

  constructor(aivis, osVoice) {
    this.#aivis = aivis;
    this.#osVoice = osVoice;
    this.#current = aivis;
  }

  async speak(text, options) {
    const outcome = await this.#aivis.speak(text, options);
    if (outcome !== aivisspeech.SpeakOutcome.FAILED_BEFORE_START) return;
    this.#current = this.#osVoice;
    await this.#osVoice.speak(text, options);
  }

  kill() {
    this.#current.kill();
  }
}

/**
 * 実行中の OS の声を返す。対応していない OS では null。
 * 読み上げが動く OS かどうか（AivisSpeech の音を鳴らせるのも同じ OS だけ）を確かめるのにも使う。
 */
function getOsVoice(env = process.env) {
  switch (process.platform) {
    case 'darwin':
      return macSay.create(env);
    case 'win32':
      return windowsSapi.create(env);
    default:
      return null;
  }
}

/**
 * 読み上げに使う声を選ぶ（VOICE_REPLY_ENGINE と、AivisSpeech Engine が応答するかで決める）。対応していない OS では null。
 * auto のときはエンジンに問い合わせるので、ほかのタブの読み上げと重ならないよう、ロックを取ってから呼ぶ
 * （ほかのタブがエンジンで音声を作っている最中に問い合わせると、応答が遅れて OS の声に切り替わるおそれがあるため）。
 */
async function chooseVoice(env = process.env) {
  const osVoice = getOsVoice(env);
  if (!osVoice) return null;
  const engine = parseEngine(env.VOICE_REPLY_ENGINE);
  if (engine === 'os') return osVoice;
  const aivis = aivisspeech.create(env);
  if (engine === 'aivisspeech') return aivis;
  return (await aivis.isAvailable()) ? new AivisSpeechWithFallback(aivis, osVoice) : osVoice;
}

module.exports = { getOsVoice, chooseVoice };
