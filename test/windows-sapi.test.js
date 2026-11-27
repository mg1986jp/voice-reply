/**
 * Windows の声（scripts/voices/windows-sapi.js）のテスト: 速さの設定から、1 秒に読む文字数を見積もる
 *   node --test test/*.test.js
 *
 * create() は読み上げを始めないので、Windows 以外でも動く。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const windowsSapi = require('../scripts/voices/windows-sapi');

test('1 秒に読む文字数は、Rate 3 で 8、Rate が 1 上がるごとに 1.116 倍。決まりに合わない Rate は初期値の 3 として見積もる', () => {
  // [CLAUDE_SAY_WIN_RATE の値, 1 秒に読む文字数（小数第 3 位まで）, 説明]
  const cases = [
    ['3', 8, '初期値'],
    ['0', 5.756, '標準の速さ（8 × 1.116^-3）'],
    ['10', 17.248, '一番速い（8 × 1.116^7）'],
    ['-10', 1.921, '一番遅い（8 × 1.116^-13）'],
    ['5.9', 9.964, '小数は切り捨てて 5 として見積もる（8 × 1.116^2）'],
    ['abc', 8, '数字でない → 初期値'],
    ['11', 8, '範囲より大きい → 初期値'],
    ['-11', 8, '範囲より小さい → 初期値'],
    [undefined, 8, '設定なし → 初期値'],
  ];
  for (const [rate, expected, label] of cases) {
    const charsPerSecond = windowsSapi.create({ CLAUDE_SAY_WIN_RATE: rate }).charsPerSecond();
    assert.equal(Number(charsPerSecond.toFixed(3)), expected, `${rate}: ${label}`);
  }
});
