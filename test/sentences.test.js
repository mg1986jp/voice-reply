/**
 * 文に分ける処理（scripts/lib/sentences.js）のテスト
 *   node --test test/*.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitSentences, MAX_SENTENCE_CHARS } = require('../scripts/lib/sentences');

/** 行の区切りの文字（LINE SEPARATOR, U+2028） */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
/** 半角の疑問符（U+003F）。test/ の下を三項演算子の記号で grep したときに、文字列の中のものと見分けがつかないため、文字コードから作る */
const HALF_WIDTH_QUESTION = String.fromCharCode(0x3f);
const repeat = (char, count) => char.repeat(count);
const words = (count) => Array(count).fill('word').join(' ');

test('文の終わりの記号（句点・感嘆符・疑問符）と改行で文に分け、閉じかっこまでを 1 つの文にする', () => {
  // [説明, 文章, 分けた文]
  const cases = [
    ['句点で分ける', 'あいう。えお。', ['あいう。', 'えお。']],
    ['感嘆符と疑問符で分ける（全角も半角も）', `すごい！本当？ok!yes${HALF_WIDTH_QUESTION}`, ['すごい！', '本当？', 'ok!', `yes${HALF_WIDTH_QUESTION}`]],
    ['続けて書いた記号は、まとめて 1 つの文の終わりにする', '本当に！？すごい。。', ['本当に！？', 'すごい。。']],
    ['全角のピリオドでも分ける', 'である．次へ．', ['である．', '次へ．']],
    ['改行で分ける（LF、CRLF、CR、行の区切りの文字）', `一行目\n二行目\r\n三行目\r四行目${LINE_SEPARATOR}五行目`, ['一行目', '二行目', '三行目', '四行目', '五行目']],
    ['文の終わりの記号がない最後の部分も、1 つの文にする', 'あ。いう', ['あ。', 'いう']],
    ['閉じかっこ・引用符までを 1 つの文にする', '「はい。」と言った。（例です。）次。', ['「はい。」', 'と言った。', '（例です。）', '次。']],
    ['前後の空白は除く', '  あ。   い。  ', ['あ。', 'い。']],
    ['半角のピリオドは、後ろが空白のときだけ分ける（v2.1.39 や speak.js は分けない）', 'v2.1.39 で speak.js を直した. 次の文', ['v2.1.39 で speak.js を直した.', '次の文']],
    ['文章の最後の半角のピリオドは、そこまでで 1 つの文', 'end.', ['end.']],
    ['記号だけの文は読まない', '…。---\n」\n   \n記号だけ→', ['記号だけ→']],
    ['空の文章は、文がない', '', []],
    ['空白と改行だけの文章は、文がない', ' \n\r\n ', []],
  ];
  for (const [label, text, expected] of cases) {
    assert.deepEqual(splitSentences(text), expected, label);
  }
});

test('100 文字を超える文は、読点 → 空白 → 文字数の順に、分けられるところで分ける', () => {
  const a = (count) => repeat('あ', count);
  const i = (count) => repeat('い', count);
  // [説明, 文章, 分けた文]
  const cases = [
    ['100 文字ちょうどの文は分けない', `${a(99)}。`, [`${a(99)}。`]],
    ['100 文字を超える文は、読点のあとで分ける', `${a(60)}、${i(60)}。`, [`${a(60)}、`, `${i(60)}。`]],
    ['読点で分けたものは、100 文字を超えない範囲でつなぎ直す', `${a(30)}、${i(30)}、${repeat('う', 50)}。`, [`${a(30)}、${i(30)}、`, `${repeat('う', 50)}。`]],
    ['全角のコンマでも分ける', `${a(60)}，${i(60)}。`, [`${a(60)}，`, `${i(60)}。`]],
    ['半角のコンマは、後ろが空白のときだけ分ける（1,000 は分けない）', `価格は1,000円です${a(80)}, ${i(20)}。`, [`価格は1,000円です${a(80)},`, `${i(20)}。`]],
    ['読点がなければ、空白のあとで分ける', `${repeat('word ', 30)}end.`, [words(20), `${words(10)} end.`]],
    ['読点も空白もなければ、100 文字ずつに切る', repeat('か', 250), [repeat('か', 100), repeat('か', 100), repeat('か', 50)]],
    ['絵文字（サロゲートペア）も 1 文字と数える', repeat('あ😀', 60), [repeat('あ😀', 50), repeat('あ😀', 10)]],
    ['切ったものが記号だけなら読まない', `あ${repeat('😀', 150)}`, [`あ${repeat('😀', 99)}`]],
  ];
  for (const [label, text, expected] of cases) {
    assert.deepEqual(splitSentences(text), expected, label);
  }
});

test('1 つの文の長さの上限は 100 文字で、引数で変えられる', () => {
  assert.equal(MAX_SENTENCE_CHARS, 100);
  assert.deepEqual(splitSentences('あいう、えお。', 4), ['あいう、', 'えお。']);
});
