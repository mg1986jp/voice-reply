/**
 * 読む文章を作る（OS や声に依存しない）
 *
 *   buildSpeechText(message)         返事から読む文章を作る（<speak> の要約、なければ Markdown を除いた全文）
 *   extractLastTurnText(transcript)  transcript JSONL から直近ターンのアシスタントの文章を取り出す
 *   TextProcessor                    Markdown 除去・コードブロック置換
 */
'use strict';

const fs = require('node:fs');

// Python の str.splitlines() と同じ文字で行を区切る（改行文字は行に残す）
const LINE_WITH_END = /[^\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]*(?:\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029])?/g;

function splitLinesKeepEnds(text) {
  return (text.match(LINE_WITH_END) || []).filter((line) => line !== '');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Markdown 記法を除去し、読み上げに適したプレーンテキストに変換する */
class TextProcessor {
  process(text) {
    text = this.#removeTimestamp(text);
    text = this.#replaceCodeBlocks(text);
    text = this.#removeInsightDecoration(text);
    text = this.#replaceUrls(text);
    text = this.#shortenLongPaths(text);
    text = this.#removeTableSeparators(text);
    text = this.#cleanTableRows(text);
    text = this.#removeHeadings(text);
    text = this.#removeEmphasis(text);
    text = this.#removeInlineCode(text);
    text = this.#removeListMarkers(text);
    text = this.#removeBlockquotes(text);
    text = this.#compressBlankLines(text);
    return text.trim();
  }

  #removeTimestamp(text) {
    return text.replace(/^回答日時：.*$/gm, '');
  }

  /** CommonMark 準拠の行単位フェンス処理。``` と ~~~ の両方に対応。 */
  #replaceCodeBlocks(text) {
    const result = [];
    let closingFence = null;
    for (const line of splitLinesKeepEnds(text)) {
      if (closingFence !== null) {
        if (closingFence.test(line.replace(/[\r\n]+$/, ''))) {
          closingFence = null;
        }
        continue;
      }
      const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
      if (match && !(match[1][0] === '`' && match[2].includes('`'))) {
        const char = escapeRegExp(match[1][0]);
        closingFence = new RegExp(`^ {0,3}${char}{${match[1].length},}[ \\t]*$`);
        result.push('コードは省略します。\n');
      } else {
        result.push(line);
      }
    }
    return result.join('');
  }

  #removeInsightDecoration(text) {
    return text.replace(/^.*[★].*Insight.*$/gm, '').replace(/─{3,}/g, '');
  }

  #replaceUrls(text) {
    return text.replace(/https?:\/\/[^\s)>\]]+/g, 'URLは省略します');
  }

  #shortenLongPaths(text) {
    // Python の \w は日本語も含むため、JS では \p{L}\p{N}_ で同じ範囲にする
    return text.replace(/(?<![.\p{L}\p{N}_])[~/](?:[^\s/]+\/){2,}[^\s/]*/gu, (p) => {
      const basename = p.replace(/\/+$/, '').split('/').pop();
      return basename ? `ファイル ${basename}` : '';
    });
  }

  #removeTableSeparators(text) {
    return text.replace(/^\|[\s\-:|]+\|$/gm, '');
  }

  #cleanTableRows(text) {
    return text.replace(/^\|(.+)\|$/gm, (_, inner) => inner.replaceAll('|', '、'));
  }

  #removeHeadings(text) {
    return text.replace(/^#{1,6}\s+/gm, '');
  }

  #removeEmphasis(text) {
    return text.replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1');
  }

  #removeInlineCode(text) {
    return text.replace(/`([^`]+)`/g, '$1');
  }

  #removeListMarkers(text) {
    // Python の \d は全角数字も含むため、JS では \p{Nd} を使う
    return text.replace(/^\s*[-*]\s+/gm, '').replace(/^\s*\p{Nd}+\.\s+/gmu, '');
  }

  #removeBlockquotes(text) {
    return text.replace(/^>\s*/gm, '');
  }

  #compressBlankLines(text) {
    return text.replace(/\n{3,}/g, '\n\n');
  }
}

/** transcript JSONL から直近ターンの全アシスタントテキストを抽出する。 */
function extractLastTurnText(transcriptPath) {
  if (!transcriptPath) return '';
  let raw;
  try {
    if (!fs.statSync(transcriptPath).isFile()) return '';
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return '';
  }

  const lines = raw.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
  const textParts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;

    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      for (let j = content.length - 1; j >= 0; j--) {
        const block = content[j];
        if (block?.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        }
      }
    } else if (entry.type === 'user') {
      if ('toolUseResult' in entry) continue;
      break;
    }
  }

  return textParts.reverse().join('\n\n');
}

const SPEAK_OPEN = '<speak>';
const SPEAK_CLOSE = '</speak>';

/**
 * 末尾の <speak>...</speak> だけを要約として採用する。
 * </speak> の後ろが空白のみの場合に限り、途中のタグは無視して全文処理に進む。
 * 末尾の要約が空なら、そのタグを除いた本文を読む。
 */
function buildSpeechText(message) {
  const end = message.lastIndexOf(SPEAK_CLOSE);
  const start = end >= SPEAK_OPEN.length ? message.lastIndexOf(SPEAK_OPEN, end - SPEAK_OPEN.length) : -1;
  let cleanText = '';
  if (start !== -1 && message.slice(end + SPEAK_CLOSE.length).trim() === '') {
    cleanText = message.slice(start + SPEAK_OPEN.length, end).trim();
    if (!cleanText) message = message.slice(0, start);
  }
  if (!cleanText) cleanText = new TextProcessor().process(message);
  return cleanText;
}

module.exports = { TextProcessor, buildSpeechText, extractLastTurnText };
