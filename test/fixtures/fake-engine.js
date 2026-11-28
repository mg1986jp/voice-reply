/**
 * テストの中で動く偽の AivisSpeech Engine（node:http）
 *
 *   const engine = await startFakeEngine(t, { speakers, plan })
 *     engine.url          つなぐ URL（http://127.0.0.1:<空いているポート>）。テストが終わると閉じる
 *     engine.requests     届いた要求（届いた順）: { path, n（その path への何回目か）, speaker, text, query（本文の JSON） }
 *     engine.aborted      応えずにいる間に、つないだ側が取りやめた要求（requests と同じもの）
 *     engine.count(path)  その path に届いた要求の数
 *
 *   speakers  GET /speakers が返す一覧（初期値は まお／ノーマル だけ）
 *   plan      path ごとに「何回目の要求に、どう応えるか」の表。表にない回は、ふつうに応える
 *               { '/synthesis': { 2: fail(500) } }   2 回目だけ失敗を返す
 *               { '/version': { other: hold } }       いつも応えずに止めておく
 *
 * ふつうの応え:
 *   GET  /version      "1.2.0"
 *   GET  /speakers     speakers
 *   POST /audio_query  { accent_phrases: [], speedScale: 1, text }（本物にはない text を入れて、synthesis に読む文章を伝える）
 *   POST /synthesis    「WAV:<audio_query の text>」というバイト列（本物の WAV ではない。偽の再生で、どの文かを見分けるため）
 *
 *   closedUrl()  何も待ち受けていない URL（エンジンが動いていないとき）
 */
'use strict';

const http = require('node:http');
const { once } = require('node:events');
const { lookup } = require('../helpers');

const DEFAULT_SPEAKERS = [{ name: 'まお', speaker_uuid: 'fake-mao', styles: [{ name: 'ノーマル', id: 888753760, type: 'talk' }] }];

function sendJson(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

/** path ごとの、ふつうの応え */
const ANSWERS = {
  '/version': ({ res }) => sendJson(res, '1.2.0'),
  '/speakers': ({ res, speakers }) => sendJson(res, speakers),
  '/audio_query': ({ res, record }) => sendJson(res, { accent_phrases: [], speedScale: 1, text: record.text }),
  '/synthesis': ({ res, record }) => {
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(Buffer.from(`WAV:${record.query.text}`, 'utf8'));
  },
};
const notFound = ({ res }) => res.writeHead(404).end();

/** plan に入れる応え: その status で失敗を返す */
const fail = (status) => ({ res }) => res.writeHead(status).end('injected failure');
/** plan に入れる応え: 応えずに止めておく。つないだ側が取りやめたら aborted に入れる */
const hold = ({ res, record, engine }) => res.on('close', () => engine.aborted.push(record));

/** 本文の JSON。JSON でなければ null */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function startFakeEngine(t, { speakers = DEFAULT_SPEAKERS, plan = {} } = {}) {
  const counts = {};
  const engine = {
    url: '',
    requests: [],
    aborted: [],
    count: (target) => engine.requests.filter((request) => request.path === target).length,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-engine');
    const body = await readBody(req);
    counts[url.pathname] = lookup(counts, url.pathname, 0) + 1;
    const record = {
      path: url.pathname,
      n: counts[url.pathname],
      speaker: url.searchParams.get('speaker'),
      text: url.searchParams.get('text'),
      query: parseJson(body),
    };
    engine.requests.push(record);
    const calls = lookup(plan, url.pathname, {});
    const answer = lookup(calls, record.n, lookup(calls, 'other', lookup(ANSWERS, url.pathname, notFound)));
    answer({ res, record, engine, speakers });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  engine.url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return engine;
}

/** 何も待ち受けていない URL（空いているポートを取って、すぐに閉じる） */
async function closedUrl() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return `http://127.0.0.1:${port}`;
}

module.exports = { startFakeEngine, closedUrl, fail, hold, DEFAULT_SPEAKERS };
