/**
 * 読み上げのオン・オフ
 *
 * データフォルダに disabled ファイルがあればオフ、なければオン（初期状態はオン）。
 * 状態はセッション（タブ）をまたいで共通。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DISABLED_FILE = 'disabled';

function isEnabled(dataDir) {
  return !fs.existsSync(path.join(dataDir, DISABLED_FILE));
}

/** オン・オフを切り替える。書き込めなければ例外を投げる。 */
function setEnabled(dataDir, enabled) {
  const file = path.join(dataDir, DISABLED_FILE);
  if (enabled) {
    fs.rmSync(file, { force: true });
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, '');
  }
}

module.exports = { isEnabled, setEnabled };
