/**
 * 読み上げの時間の上限（scripts/lib/speech-limit.js）のテスト
 *   node --test test/*.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { speechTimeLimitMs, voiceTimeLimitMs, STOP_GRACE_MS } = require('../scripts/lib/speech-limit');

test('上限は、文字数を 1 秒に読む文字数で割った見積もりの 2 倍に、30 秒を足した時間', () => {
  // [説明, 読む文章, 1 秒に読む文字数, 上限（ミリ秒）]
  const cases = [
    ['空の文章は 30 秒', '', 8, 30000],
    ['400 文字を 1 秒 8 文字で読むなら 130 秒', 'あ'.repeat(400), 8, 130000],
    ['長い文章でも頭打ちにならない（4646 文字で約 20 分）', 'あ'.repeat(4646), 8, 1191500],
    ['もっと長い文章でも頭打ちにならない（10 万文字）', 'あ'.repeat(100000), 8, 25030000],
    ['絵文字（サロゲートペア）も 1 文字と数える', '😀'.repeat(8), 8, 32000],
    ['空白と改行も 1 文字と数える', 'あ \n'.repeat(4), 8, 33000],
    ['ミリ秒の端数は切り上げる', 'あ', 3, 30667],
    ['setTimeout() に渡せる最大値（2^31 − 1 ミリ秒）で頭打ちになる', 'あ'.repeat(1100000), 1, 2 ** 31 - 1],
  ];
  for (const [label, text, charsPerSecond, expected] of cases) {
    assert.equal(speechTimeLimitMs(text, charsPerSecond), expected, label);
  }
});

test('charsPerSecond() を持つ声では、その速さで上限を決め、持たない声では上限を設けない', () => {
  const text = 'あ'.repeat(400);
  // [説明, 声, 上限（ミリ秒）。null は上限なし]
  const cases = [
    ['1 秒に 8 文字の声', { charsPerSecond: () => 8 }, 130000],
    ['1 秒に 16 文字の声', { charsPerSecond: () => 16 }, 80000],
    ['charsPerSecond() を持たない声', {}, null],
  ];
  for (const [label, voice, expected] of cases) {
    assert.equal(voiceTimeLimitMs(voice, text), expected, label);
  }
});

test('声を止めてから、読み上げが終わるのを待つのは 2 秒', () => {
  assert.equal(STOP_GRACE_MS, 2000);
});
