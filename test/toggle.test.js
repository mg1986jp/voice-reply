/**
 * /voice-reply:toggle のフック（scripts/toggle.js）を実際に起動するテスト: オンにしたとき、読み上げが動く OS でだけ要約の指示を渡す
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

const TOGGLE = path.join(__dirname, '..', 'scripts', 'toggle.js');
const PLATFORM = path.join(__dirname, 'fixtures', 'platform.js');

test('オンにしたとき、読み上げが動く OS（Mac・Windows）では要約の指示を渡し、それ以外の OS では「声がない」と伝える', (t) => {
  const dataDir = h.makeWorkDir(t);
  const withPrompt = `voice-reply の読み上げをオンにした。\n\n${readSpeakPrompt()}`;
  const noVoice = 'voice-reply の読み上げをオンにした。ただし、この OS には対応する声がないため、読み上げは動かない。<speak> の要約は付けなくてよい。';
  // [OS, Claude に伝える文章]
  const cases = [
    ['darwin', withPrompt],
    ['win32', withPrompt],
    ['linux', noVoice],
  ];
  for (const [platform, expected] of cases) {
    const result = spawnSync(process.execPath, ['--require', PLATFORM, TOGGLE], {
      env: { ...h.envWithoutVoiceReply(), CLAUDE_PLUGIN_DATA: dataDir, FAKE_PLATFORM: platform },
      input: JSON.stringify({ hook_event_name: 'UserPromptExpansion', command_name: 'voice-reply:toggle', command_args: 'on' }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, platform);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, expected, platform);
  }
});
