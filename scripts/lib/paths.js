/**
 * プラグインのファイルの置き場所
 *
 * データフォルダは Claude Code がフックに渡す CLAUDE_PLUGIN_DATA（~/.claude/plugins/data/<id>/）。
 * プラグインを更新しても残り、最後の場所からアンインストールすると消える。
 */
'use strict';

const path = require('node:path');

/** プラグインのデータフォルダ。Claude Code から渡されていなければ null。 */
function getDataDir(env = process.env) {
  return env.CLAUDE_PLUGIN_DATA || null;
}

/** 排他制御の一時ファイル（ロック、状態、最新の要求）を置くフォルダ */
function getWorkDir(dataDir) {
  return path.join(dataDir, 'tmp');
}

module.exports = { getDataDir, getWorkDir };
