#!/usr/bin/env node
/**
 * Stop フック: Claude Code の返事を声で読み上げる
 *
 * hooks/hooks.json で Stop に async: true で登録し、バックグラウンドで動作する。
 *
 * 返事の末尾に <speak>〜</speak> タグがあればその中身だけを読む。
 * なければ全文から Markdown を除去して読む。
 *
 * 排他制御:
 *   同じタブ（同一セッション）→ 読んでいる本人が新しい返事に気づいて自分の声を止め、新しい方に差し替え
 *   別のタブ（別セッション）→ 順番待ち
 *   ほかのプロセスは止めない（手動の say なども一切触らない）
 *   声が読む区切り（OS の声は全体、AivisSpeech は文）ごとに、文字数と声の速さから決めた時間の上限があり、超えたら自分の声を止める
 *   自分の声を止めても読み上げが終わらないときは、少し待って、ロックを返して終わる
 *
 * 声の選択:
 *   ロックを取ってから選ぶ（AivisSpeech Engine が応答すれば AivisSpeech、しなければ OS の声。voices/index.js を参照）。
 *   ほかのタブがエンジンで音声を作っている最中に問い合わせると、応答が遅れて OS の声に切り替わるおそれがあるため
 *
 * 構成:
 *   lib/text.js          読む文章を作る（OS 非依存）
 *   lib/speech-queue.js  mkdir ベースの排他制御（OS 非依存）
 *   lib/speech-limit.js  読み上げの時間の上限と、そのタイマー、止めるときの時間の決まり（OS 非依存）
 *   lib/sentences.js     読む文章を文に分ける（OS 非依存。AivisSpeech が使う）
 *   lib/wav-player.js    WAV を鳴らす（OS ごとの鳴らし方。AivisSpeech が使う）
 *   voices/              声ごとの読み上げ処理と、使う声の選択
 *
 * 読み上げがオフ（/voice-reply:toggle off）のときは、何もせずにすぐ終わる。
 * 順番待ちのあいだにオフにされたときも、順番が来た時点で確かめ直して、読まずに終わる。
 * 一時ファイルはプラグインのデータフォルダ（CLAUDE_PLUGIN_DATA）の tmp/ に置き、読み上げの最後に、古くなったものを片付ける。
 * AivisSpeech の WAV は audio/ に置き、鳴らし終えたらすぐに消す。
 * 声と速さの設定は voices/ の各ファイルを参照。Node の標準モジュールだけで動く（npm パッケージ不要）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSpeechText, extractLastTurnText } = require('./lib/text');
const { SpeechQueue } = require('./lib/speech-queue');
const { getDataDir, getWorkDir } = require('./lib/paths');
const { voiceTimeLimitMs, SpeechLimitTimer, STOP_GRACE_MS } = require('./lib/speech-limit');
const { isEnabled } = require('./lib/state');
const { getOsVoice, chooseVoice } = require('./voices');

function readHookInput() {
  try {
    const data = JSON.parse(fs.readFileSync(0, 'utf8'));
    return data !== null && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

async function main() {
  const dataDir = getDataDir();
  // オフのときは、返事を読む前にすぐ終わる
  if (!dataDir || !isEnabled(dataDir)) return;

  const input = readHookInput();
  if (!input) return;

  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';

  let message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  if (!message.trim()) {
    message = extractLastTurnText(typeof input.transcript_path === 'string' ? input.transcript_path : '');
  }
  if (!message.trim()) return;

  let speechText = buildSpeechText(message);
  if (!speechText) return;

  const folderName = typeof input.cwd === 'string' && input.cwd ? path.basename(input.cwd) : '';
  if (folderName) speechText = `${folderName}の作業です。\n\n${speechText}`;

  // 読み上げが動かない OS では、何もせずに終わる（使う声を選ぶのは、ロックを取ってから）
  if (!getOsVoice()) return;
  const queue = new SpeechQueue(sessionId, getWorkDir(dataDir));
  let voice = null;

  // ロックを返し、後片付けをして、すぐに終わる。process.exit() は finally を飛ばすため、必ずその直前で行う
  const finishNow = () => {
    queue.release();
    queue.cleanupTempFiles();
    process.exit(0);
  };
  const handleSignal = () => {
    voice?.kill();
    finishNow();
  };
  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);

  // 自分の声だけを止める。ふつうは声が止まると読み上げが終わり、finally でロックを返す。
  // 止めても STOP_GRACE_MS のうちに読み上げが終わらないときは、待つのをやめて、ロックを返して終わる。
  // 声を選んでいる最中に呼ばれたときは、選び終えても読まずに終わる
  let stopped = false;
  let graceTimer = null;
  const stopVoice = () => {
    stopped = true;
    voice?.kill();
    graceTimer ??= setTimeout(finishNow, STOP_GRACE_MS).unref();
  };
  // 読み上げが時間の上限を超えたら、自分の声を止める（声だけが固まったときに、ほかのタブを待たせ続けないため）
  const limitTimer = new SpeechLimitTimer(stopVoice);

  try {
    if (!(await queue.acquire())) return;
    // 順番待ちのあいだにオフにされていたら、読まずに終わる（ロックは finally で返す）。
    // 読み始めたあとにオフにされた場合は、確かめ直さずに最後まで読む
    if (!isEnabled(dataDir)) return;
    // 同じタブの新しい返事が来たとき、またはロックを失ったとき（合図が途切れた間にほかのタブに取られたとき）は、自分の声を止める
    queue.startWatching(stopVoice);
    voice = await chooseVoice();
    if (!voice || stopped) return;
    // 時間の上限は、声が区切り（OS の声は全体、AivisSpeech は文）に取りかかるたびに、その区切りの文字数と、
    // その区切りを読む声の速さから決め直す（AivisSpeech から OS の声に切り替わったときは、OS の声の速さで決める）。
    // 順番待ちの時間は数えない。速さを見積もれない声では上限を設けない
    await voice.speak(speechText, {
      onSegment: (segment, segmentVoice) => limitTimer.restart(voiceTimeLimitMs(segmentVoice, segment)),
    });
  } finally {
    limitTimer.clear();
    clearTimeout(graceTimer);
    queue.release();
    queue.cleanupTempFiles();
  }
}

main().catch(() => process.exit(0));
