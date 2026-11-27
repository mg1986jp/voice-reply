#!/usr/bin/env node
/**
 * SessionStart フック: 読み上げ用の要約（<speak>）の指示を Claude に渡す
 *
 * hooks/hooks.json で SessionStart に登録する（matcher なし）。新しいセッション、再開、/clear、
 * 圧縮、フォークのたびに動くので、圧縮や /clear のあとも指示が届く。
 * 指示の文章は prompts/speak.md に置き、ここでは読み込んで additionalContext として出すだけにする。
 *
 * 読み上げがオフのときは指示を渡さない（オンに切り替えたときは、toggle.js がその場で渡す）。
 *
 * どんなときも終了コード 0 で終わる。指示を読めないときは、何も出さずに終わる（Claude の動きを止めない）。
 */
'use strict';

const { getDataDir } = require('./lib/paths');
const { isEnabled } = require('./lib/state');
const { readSpeakPrompt } = require('./lib/prompts');
const { getVoice } = require('./voices');

function main() {
  // データフォルダがないときや、OS に合う声がないときは、読み上げ（speak.js）も動かないので渡さない
  const dataDir = getDataDir();
  if (!dataDir || !isEnabled(dataDir) || !getVoice()) return;
  const prompt = readSpeakPrompt();
  if (!prompt) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: prompt },
  }));
}

try {
  main();
} catch {
  // 何があってもセッションの開始は止めない
}
