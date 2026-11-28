/**
 * 読む文章を文に分ける（OS や声に依存しない）
 *
 *   splitSentences(text, maxChars)  文の終わり（句点・感嘆符・疑問符）と改行で文に分け、maxChars より長い文は読点などでさらに分ける
 *
 * 文ごとに音声を作る声（AivisSpeech）が使う。1 回に作る文章が短いほど、最初の音声が早くでき、エンジンのメモリも増えにくい
 * （AivisSpeech Engine の README は、1 回に送る文章を 500 文字以内にすすめている）。
 */
'use strict';

/** 1 つの文の長さの上限（文字数）。これより長い文は、読点・空白の順に、分けられるところで分ける */
const MAX_SENTENCE_CHARS = 100;

/** 行の区切り */
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
/**
 * 1 つの文: 文の終わりの記号（続けて書いたもの、たとえば「？！」はまとめる）と、そのあとの閉じかっこ・引用符までを 1 つの文にする。
 * 半角のピリオドは、後ろが空白のときだけ文の終わりとみなす（「v2.1」「speak.js」「3.14」を分けないため）。
 * 行の最後に、文の終わりの記号がないまま残った部分も 1 つの文にする。
 */
const SENTENCE = /[^]*?(?:[。．！？!?]+[」』）)】〕〉》"'”’]*|\.(?=\s)|$)/gu;
/** 長すぎる文を分けるところ（その記号のあと）: 読点。半角のコンマは、後ろが空白のときだけ（「1,000」を分けないため） */
const CLAUSE_BREAK = /(?<=[、，])|(?<=,)(?=\s)/u;
/** 読点で分けても長すぎるときに分けるところ: 空白のあと */
const WORD_BREAK = /(?<=\s)/u;
/** 読むものがある（文字か数字を含む）。記号だけの文（「」」「---」など）は読まない */
const READABLE = /[\p{L}\p{N}]/u;

/** 文字数。絵文字などのサロゲートペアも 1 文字と数える（lib/speech-limit.js と同じ数え方） */
function countChars(text) {
  return [...text].length;
}

/**
 * 細かく分けたものを、maxChars を超えない範囲で前から順につなぎ直す。
 * pieces は、空でない文を記号や空白のあとで分けたもので、どれも空ではない（前から読む区切りは文の頭にはこないため）
 */
function pack(pieces, maxChars) {
  const packed = [];
  let current = '';
  for (const piece of pieces) {
    if (current !== '' && countChars(current + piece) > maxChars) {
      packed.push(current);
      current = '';
    }
    current += piece;
  }
  packed.push(current);
  return packed;
}

/** maxChars 文字ずつに切る（読点も空白もない長い文の、最後の手段） */
function chunk(text, maxChars) {
  const chars = [...text];
  const chunks = [];
  for (let i = 0; i < chars.length; i += maxChars) chunks.push(chars.slice(i, i + maxChars).join(''));
  return chunks;
}

/** maxChars より長い文を、読点 → 空白 → 文字数の順に、分けられるところで分ける */
function splitLongSentence(sentence, maxChars) {
  const fits = (text) => countChars(text) <= maxChars;
  if (fits(sentence)) return [sentence];
  return pack(sentence.split(CLAUSE_BREAK), maxChars).flatMap((clause) =>
    fits(clause)
      ? [clause]
      : pack(clause.split(WORD_BREAK), maxChars).flatMap((words) => (fits(words) ? [words] : chunk(words, maxChars))),
  );
}

/** 前後の空白を除き、読むものがない文を落とす */
function tidy(sentences) {
  return sentences.map((sentence) => sentence.trim()).filter((sentence) => READABLE.test(sentence));
}

/**
 * 文章を、読む順に文に分ける
 * @param {string} text      読む文章
 * @param {number} maxChars  1 つの文の長さの上限（文字数）
 * @returns {string[]}       文（前後の空白を除いたもの）。読むものがなければ空の配列
 */
function splitSentences(text, maxChars = MAX_SENTENCE_CHARS) {
  const sentences = tidy(text.split(LINE_BREAK).flatMap((line) => [...line.matchAll(SENTENCE)].map((match) => match[0])));
  return tidy(sentences.flatMap((sentence) => splitLongSentence(sentence, maxChars)));
}

module.exports = { splitSentences, MAX_SENTENCE_CHARS };
