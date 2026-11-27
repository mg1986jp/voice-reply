#!/usr/bin/env node
/**
 * UserPromptExpansion フック: /voice-reply:toggle [on|off] を受けて、読み上げのオン・オフを切り替える
 *
 * hooks/hooks.json で UserPromptExpansion に matcher「^voice-reply:toggle$」で登録する。
 * 切り替えはこのフックで済ませ、結果を additionalContext で Claude に伝える（コマンドの実行はブロックしない）。
 * Claude にシェルを実行させないので、OS やシェル、許可の設定に左右されない。
 *
 *   引数なし  今と逆にする
 *   on / off  その状態にする
 *
 * オンにしたときは、読み上げ用の要約の指示（prompts/speak.md）もあわせて渡す。
 * そのセッションの始めにオフで、指示を受け取っていない場合があるため。
 * どんなときも終了コード 0 で終わる。
 */
'use strict';

const fs = require('node:fs');
const { getDataDir } = require('./lib/paths');
const { isEnabled, setEnabled } = require('./lib/state');
const { readSpeakPrompt } = require('./lib/prompts');

function readHookInput() {
  try {
    const data = JSON.parse(fs.readFileSync(0, 'utf8'));
    return data !== null && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** 引数から、切り替えたあとの状態を決める。使えない引数なら null。 */
function decideEnabled(args, current) {
  const arg = args.trim().toLowerCase();
  if (arg === '') return !current;
  if (arg === 'on') return true;
  if (arg === 'off') return false;
  return null;
}

function buildMessage(input) {
  const dataDir = getDataDir();
  if (!dataDir) {
    return 'voice-reply の読み上げを切り替えられなかった（Claude Code からプラグインのデータフォルダが渡されなかった）。';
  }
  const current = isEnabled(dataDir);
  const args = typeof input.command_args === 'string' ? input.command_args : '';
  const next = decideEnabled(args, current);
  if (next === null) {
    return `voice-reply の読み上げの切り替えで、引数「${args.trim()}」は使えない（使えるのは on と off、または引数なし）。` +
      `読み上げは${current ? 'オン' : 'オフ'}のまま。`;
  }
  try {
    setEnabled(dataDir, next);
  } catch (err) {
    return `voice-reply の読み上げを切り替えられなかった（${err.message}）。読み上げは${current ? 'オン' : 'オフ'}のまま。`;
  }
  if (!next) {
    return 'voice-reply の読み上げをオフにした。これ以降の返事は読み上げられないので、<speak> の要約は付けなくてよい。';
  }
  const prompt = readSpeakPrompt();
  return prompt ? `voice-reply の読み上げをオンにした。\n\n${prompt}` : 'voice-reply の読み上げをオンにした。';
}

try {
  const message = buildMessage(readHookInput());
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptExpansion', additionalContext: message },
  }));
} catch {
  // 何があってもコマンドの実行は止めない
}
