/**
 * Windows のコマンドの絶対パス
 *
 * フックは作業中のフォルダで動くため、名前だけで呼ぶと同じ名前の実行ファイルを拾うおそれがある。
 * そこで System32 の下を絶対パスで呼ぶ。
 */
'use strict';

const path = require('node:path');

const WIN_SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

module.exports = {
  WIN_POWERSHELL: path.join(WIN_SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
};
