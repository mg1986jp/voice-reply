/**
 * Mac の声（scripts/voices/mac-say.js）のテスト: 速さの設定から、1 秒に読む文字数を見積もる
 *   node --test test/*.test.js
 *
 * create() は読み上げを始めないので、Mac 以外でも動く。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const macSay = require('../scripts/voices/mac-say');

const charsPerSecondAt = (rate) => macSay.create({ CLAUDE_SAY_RATE: rate }).charsPerSecond();

test('1 秒に読む文字数は、-r 260 で 8、-r に比例し、770 で頭打ち。正の整数でない -r は初期値の 260 として見積もる', () => {
  // [CLAUDE_SAY_RATE の値, 1 秒に読む文字数（小数第 3 位まで）, 説明]
  const cases = [
    ['260', 8, '初期値'],
    ['520', 16, '初期値の 2 倍の速さ'],
    ['100', 3.077, '-r に比例して遅くなる（8 × 100 ÷ 260）'],
    ['770', 23.692, '頭打ちになる速さ（8 × 770 ÷ 260）'],
    ['1000', 23.692, '770 より上は 770 と同じ'],
    ['250.7', 7.692, '小数は切り捨てて 250 として見積もる'],
    ['abc', 8, '数字でない → 初期値'],
    ['0', 8, '正でない → 初期値'],
    ['-5', 8, '負の数 → 初期値'],
    [undefined, 8, '設定なし → 初期値'],
  ];
  for (const [rate, expected, label] of cases) {
    assert.equal(Number(charsPerSecondAt(rate).toFixed(3)), expected, `${rate}: ${label}`);
  }
});

test('-r 770 より上は、770 とまったく同じ速さに見積もる（実際の声が速くならないため）', () => {
  // [CLAUDE_SAY_RATE の値]
  const aboveCap = ['771', '1000', '5000'];
  for (const rate of aboveCap) {
    assert.equal(charsPerSecondAt(rate), charsPerSecondAt('770'), rate);
  }
});
