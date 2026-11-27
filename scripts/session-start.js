#!/usr/bin/env node
/**
 * SessionStart フック: 読み上げ用の要約（<speak>）の指示を Claude に渡す
 *
 * hooks/hooks.json で SessionStart に登録する（matcher なし）。新しいセッション、再開、/clear、
 * 圧縮、フォークのたびに動くので、圧縮や /clear のあとも指示が届く。
 * 指示の文章は prompts/speak.md に置き、ここでは読み込んで additionalContext として出すだけにする。
 *
 * どんなときも終了コード 0 で終わる。指示を読めないときは、何も出さずに終わる（Claude の動きを止めない）。
 */
'use strict';

const { readSpeakPrompt } = require('./lib/prompts');

function main() {
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
