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
 *
 * 構成:
 *   lib/text.js          読む文章を作る（OS 非依存）
 *   lib/speech-queue.js  mkdir ベースの排他制御（OS 非依存）
 *   voices/              声ごとの読み上げ処理と、OS に合う声の選択
 *
 * 読み上げがオフ（/voice-reply:toggle off）のときは、何もせずにすぐ終わる。
 * 順番待ちのあいだにオフにされたときも、順番が来た時点で確かめ直して、読まずに終わる。
 * 一時ファイルはプラグインのデータフォルダ（CLAUDE_PLUGIN_DATA）の tmp/ に置き、読み上げの最後に、古くなったものを片付ける。
 * 声と速さの設定は voices/ の各ファイルを参照。Node の標準モジュールだけで動く（npm パッケージ不要）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSpeechText, extractLastTurnText } = require('./lib/text');
const { SpeechQueue } = require('./lib/speech-queue');
const { getDataDir, getWorkDir } = require('./lib/paths');
const { isEnabled } = require('./lib/state');
const { getVoice } = require('./voices');

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

  const voice = getVoice();
  if (!voice) return;
  const queue = new SpeechQueue(sessionId, getWorkDir(dataDir));

  // process.exit() は finally を飛ばすため、ロック解放と後片付けは必ずその直前で行う
  const handleSignal = () => {
    voice.kill();
    queue.release();
    queue.cleanupTempFiles();
    process.exit(0);
  };
  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);

  try {
    if (!(await queue.acquire())) return;
    // 順番待ちのあいだにオフにされていたら、読まずに終わる（ロックは finally で返す）。
    // 読み始めたあとにオフにされた場合は、確かめ直さずに最後まで読む
    if (!isEnabled(dataDir)) return;
    // 同じタブの新しい返事が来たとき、またはロックを失ったとき（合図が途切れた間にほかのタブに取られたとき）は、
    // 自分の声だけを止める（声が止まると読み上げが終わり、finally でロックを返す）
    queue.startWatching(() => voice.kill());
    await voice.speak(speechText);
  } finally {
    queue.release();
    queue.cleanupTempFiles();
  }
}

main().catch(() => process.exit(0));
