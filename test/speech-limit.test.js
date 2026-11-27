/**
 * 読み上げの時間の上限（scripts/lib/speech-limit.js）のテスト
 *   node --test test/*.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { speechTimeLimitMs, voiceTimeLimitMs, SpeechLimitTimer, STOP_GRACE_MS } = require('../scripts/lib/speech-limit');

test('上限は、文字数を 1 秒に読む文字数で割った見積もりの 2.5 倍に、30 秒を足した時間', () => {
  // [説明, 読む文章, 1 秒に読む文字数, 上限（ミリ秒）]
  const cases = [
    ['空の文章は 30 秒', '', 8, 30000],
    ['400 文字を 1 秒 8 文字で読むなら 155 秒', 'あ'.repeat(400), 8, 155000],
    ['長い文章でも頭打ちにならない（4646 文字で約 25 分）', 'あ'.repeat(4646), 8, 1481875],
    ['もっと長い文章でも頭打ちにならない（10 万文字）', 'あ'.repeat(100000), 8, 31280000],
    ['絵文字（サロゲートペア）も 1 文字と数える', '😀'.repeat(8), 8, 32500],
    ['空白と改行も 1 文字と数える', 'あ \n'.repeat(4), 8, 33750],
    ['ミリ秒の端数は切り上げる', 'あ', 3, 30834],
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
    ['1 秒に 8 文字の声', { charsPerSecond: () => 8 }, 155000],
    ['1 秒に 16 文字の声', { charsPerSecond: () => 16 }, 92500],
    ['charsPerSecond() を持たない声', {}, null],
  ];
  for (const [label, voice, expected] of cases) {
    assert.equal(voiceTimeLimitMs(voice, text), expected, label);
  }
});

test('声を止めてから、読み上げが終わるのを待つのは 2 秒', () => {
  assert.equal(STOP_GRACE_MS, 2000);
});

// SpeechLimitTimer のテストは、node:test のモックの時計（setTimeout と clearTimeout）で時間を進める

test('SpeechLimitTimer は restart() のたびに測り直し、最後に測り直した上限を超えたときに 1 回だけ呼ぶ', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let expired = 0;
  const timer = new SpeechLimitTimer(() => {
    expired += 1;
  });

  timer.restart(1000);
  t.mock.timers.tick(999);
  assert.equal(expired, 0, '上限の手前では呼ばない');
  timer.restart(500); // 次の区切りに取りかかった
  t.mock.timers.tick(499);
  assert.equal(expired, 0, '測り直したら、新しい上限の手前では呼ばない（前の上限の 1000ms は過ぎている）');
  t.mock.timers.tick(1);
  assert.equal(expired, 1, '新しい上限を超えたら呼ぶ');
  t.mock.timers.tick(10000);
  assert.equal(expired, 1, '1 回だけ呼ぶ');
});

test('SpeechLimitTimer は clear() で止め、restart(null) では測らない（前の上限も取り消す）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // [説明, タイマーにすること]
  const cases = [
    ['clear() したら呼ばない', (timer) => {
      timer.restart(100);
      timer.clear();
    }],
    ['null で測り直したら、前の上限も取り消して、測らない', (timer) => {
      timer.restart(100);
      timer.restart(null);
    }],
    ['null だけなら測らない（速さを見積もれない声）', (timer) => timer.restart(null)],
    ['測っていないときに clear() を 2 回呼んでもよい', (timer) => {
      timer.clear();
      timer.clear();
    }],
  ];
  for (const [label, act] of cases) {
    let expired = 0;
    act(new SpeechLimitTimer(() => {
      expired += 1;
    }));
    t.mock.timers.tick(2 ** 31 - 1);
    assert.equal(expired, 0, label);
  }
});
