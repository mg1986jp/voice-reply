/**
 * Claude に渡す文章（prompts/ の下のファイル）を読む
 *
 * 文章はコードに書かず prompts/ に置く。文章を直すときにコードを触らずに済むようにするため。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');

/**
 * 読み上げ用の要約の指示（prompts/speak.md）を返す。
 * 読めないとき、または空のときは空文字を返す（呼び出し側は指示を渡さないだけにする）。
 */
function readSpeakPrompt() {
  try {
    return fs.readFileSync(path.join(PROMPTS_DIR, 'speak.md'), 'utf8').replace(/\r\n?/g, '\n').trim();
  } catch {
    return '';
  }
}

module.exports = { readSpeakPrompt };
