/**
 * SessionStart フック（scripts/session-start.js）を実際に起動するテスト: 読み上げが動く OS でだけ、要約の指示を渡す
 *   node --test test/*.test.js
 *
 * OS は test/fixtures/platform.js で決める（どの OS でも、Mac・Windows・それ以外のふるまいを確かめるため）。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const h = require('./helpers');
const { readSpeakPrompt } = require('../scripts/lib/prompts');

const SESSION_START = path.join(__dirname, '..', 'scripts', 'session-start.js');
const PLATFORM = path.join(__dirname, 'fixtures', 'platform.js');

test('読み上げが動く OS（Mac・Windows）では要約の指示を渡し、それ以外の OS では何も渡さない', (t) => {
  const dataDir = h.makeWorkDir(t);
  const prompt = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: readSpeakPrompt() } });
  // [OS, 標準出力]
  const cases = [
    ['darwin', prompt],
    ['win32', prompt],
    ['linux', ''],
  ];
  for (const [platform, expected] of cases) {
    const result = spawnSync(process.execPath, ['--require', PLATFORM, SESSION_START], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, FAKE_PLATFORM: platform },
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, platform);
    assert.equal(result.stdout, expected, platform);
  }
});
