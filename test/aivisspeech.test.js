/**
 * AivisSpeech の声（scripts/voices/aivisspeech.js）のテスト
 *   node --test test/*.test.js
 *
 * エンジンは、テストの中で動く偽物（test/fixtures/fake-engine.js）を使う。本物のエンジンにはつながない。
 * 音は、child_process.spawn を偽物（test/fixtures/fake-spawn.js）に差し替えて鳴らさない。
 * 鳴らし方は Mac（afplay）にそろえる（どの OS でも同じ確かめ方にするため。Windows の鳴らし方は wav-player.test.js で確かめる）。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./helpers');
const { startFakeEngine, closedUrl, fail, hold } = require('./fixtures/fake-engine');

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', { ...realPlatform, value: 'darwin' });
const fake = require('./fixtures/fake-spawn').install();
// spawn を差し替えたあとに読み込む（scripts/lib/wav-player.js は読み込んだ時点で spawn を受け取る）
const aivisspeech = require('../scripts/voices/aivisspeech');

const { SpeakOutcome } = aivisspeech;

/** フォルダの中のファイル名。フォルダがなければ空 */
function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** 偽の afplay に渡された WAV: { file, text（WAV の中身）, filesAtPlay（鳴らし始めたときに、同じフォルダにあったファイル） } */
function recordPlay(child) {
  const file = child.args[0];
  return { file, text: fs.readFileSync(file, 'utf8'), filesAtPlay: fs.readdirSync(path.dirname(file)) };
}

/** 偽の afplay の動き: 渡された WAV を記録し、すぐに鳴らし終えたことにする */
const playInstantly = (played) => (child) => {
  played.push(recordPlay(child));
  setImmediate(() => child.finish(0));
};

/** 偽のエンジンと、それにつなぐ声を用意する。偽の afplay は、すぐに鳴らし終える */
async function setup(t, { env = {}, speakers, plan } = {}) {
  const dataDir = h.makeWorkDir(t);
  const engine = await startFakeEngine(t, { speakers, plan });
  const played = [];
  fake.spawned.length = 0;
  fake.onSpawn = playInstantly(played);
  const voice = aivisspeech.create({ CLAUDE_PLUGIN_DATA: dataDir, VOICE_REPLY_AIVIS_URL: engine.url, ...env });
  return { dataDir, audioDir: path.join(dataDir, 'audio'), engine, voice, played };
}

/** 読ませて、結果と onSegment に渡されたもの（{ segment, by }）を返す */
async function speakRecording(voice, text) {
  const segments = [];
  const outcome = await voice.speak(text, { onSegment: (segment, by) => segments.push({ segment, by }) });
  return { outcome, segments };
}

test('最後まで読む: 文ごとに audio_query → synthesis で WAV を作って順に鳴らし、文ごとに onSegment(文, この声) を呼ぶ', async (t) => {
  const env = await setup(t);
  const sentences = ['一文目です。', '二文目です！', '三行目'];

  const { outcome, segments } = await speakRecording(env.voice, '一文目です。二文目です！\n三行目');

  assert.equal(outcome, SpeakOutcome.FINISHED);
  assert.deepEqual(segments.map(({ segment }) => segment), sentences);
  assert.ok(segments.every(({ by }) => by === env.voice), 'onSegment には、読んでいるこの声を渡す');
  assert.deepEqual(env.played.map(({ text }) => text), sentences.map((sentence) => `WAV:${sentence}`), '作った順に鳴らす');
  assert.deepEqual(
    env.engine.requests.map(({ path: target, speaker, text }) => [target, speaker, text]),
    [
      ['/speakers', null, null],
      ...sentences.flatMap((sentence) => [['/audio_query', '888753760', sentence], ['/synthesis', '888753760', null]]),
    ],
    '声の一覧を 1 回だけ問い合わせ、文ごとに初期の声（まお／ノーマル）で作る',
  );
  assert.deepEqual(env.engine.requests.filter((request) => request.path === '/synthesis').map(({ query }) => query.speedScale), [1.4, 1.4, 1.4], '初期の速さ 1.4 で作る');
  assert.deepEqual(listDir(env.audioDir), [], 'WAV は残らない');
});

test('1 文を鳴らしている間に、次の文を作る（onSegment を渡さなくても読める）', async (t) => {
  const env = await setup(t);
  const held = [];
  fake.onSpawn = (child) => held.push(child);

  const speaking = env.voice.speak('一文目です。二文目です。');
  await h.waitFor(() => held.length === 1, 5000, '1 文目を鳴らし始める');
  await h.waitFor(() => env.engine.count('/synthesis') === 2, 5000, '1 文目を鳴らしている間に、2 文目を作る');
  held[0].finish(0);
  await h.waitFor(() => held.length === 2, 5000, '1 文目を鳴らし終えたら、2 文目を鳴らす');
  held[1].finish(0);

  assert.equal(await speaking, SpeakOutcome.FINISHED);
  assert.deepEqual(listDir(env.audioDir), []);
});

test('設定のスタイルがエンジンに入っていれば、それを使い、入っていなければ入っている声の最初のスタイル（読み上げ用のもの）を使う', async (t) => {
  // [説明, エンジンの声の一覧, VOICE_REPLY_AIVIS_STYLE, 使うスタイル ID]
  const cases = [
    ['設定（初期値のまお／ノーマル）が入っていれば、それを使う', [{ styles: [{ id: 1, type: 'talk' }, { id: 888753760, type: 'talk' }] }], undefined, '888753760'],
    ['設定したスタイル（負の数の ID）が入っていれば、それを使う', [{ styles: [{ id: 1 }, { id: -5 }] }], '-5', '-5'],
    ['入っていなければ、最初の声の最初のスタイル', [{ styles: [{ id: 5, type: 'talk' }] }, { styles: [{ id: 6, type: 'talk' }] }], undefined, '5'],
    ['読み上げ用でないスタイル（type が talk 以外）は飛ばす', [{ styles: [{ id: 7, type: 'sing' }, { id: 8, type: 'talk' }] }], undefined, '8'],
    ['type のないスタイルは、読み上げ用として扱う', [{ styles: [{ id: 9 }] }], undefined, '9'],
    ['形のおかしい声とスタイルは飛ばす', [null, { name: 'styles なし' }, { styles: 'x' }, { styles: [null, { id: '10' }, { id: 1.5 }, { id: 11 }] }], undefined, '11'],
  ];
  for (const [label, speakers, style, expected] of cases) {
    const env = await setup(t, { speakers, env: { VOICE_REPLY_AIVIS_STYLE: style } });
    assert.equal(await env.voice.speak('読みます。'), SpeakOutcome.FINISHED, label);
    const used = env.engine.requests.filter((request) => request.path !== '/speakers').map(({ speaker }) => speaker);
    assert.deepEqual(used, [expected, expected], label);
  }
});

test('1 文目を鳴らし始める前に失敗したら FAILED_BEFORE_START（何も鳴らさず、WAV も残さない）', async (t) => {
  const unreachable = await closedUrl();
  // [説明, エンジンの声の一覧, エンジンの応え方, ほかの環境変数]
  const cases = [
    ['声が 1 つも入っていない', [], {}, {}],
    ['声の一覧が配列でない', {}, {}, {}],
    ['声の一覧の問い合わせが失敗（500）', undefined, { '/speakers': { 1: fail(500) } }, {}],
    ['1 文目の audio_query が失敗（500）', undefined, { '/audio_query': { 1: fail(500) } }, {}],
    ['1 文目の synthesis が失敗（422）', undefined, { '/synthesis': { 1: fail(422) } }, {}],
    ['エンジンにつながらない', undefined, {}, { VOICE_REPLY_AIVIS_URL: unreachable }],
  ];
  for (const [label, speakers, plan, extraEnv] of cases) {
    const env = await setup(t, { speakers, plan, env: extraEnv });
    assert.equal(await env.voice.speak('一文目です。二文目です。'), SpeakOutcome.FAILED_BEFORE_START, label);
    assert.deepEqual(env.played, [], `${label}: 何も鳴らさない`);
    assert.deepEqual(listDir(env.audioDir), [], `${label}: WAV を残さない`);
  }
});

test('2 文目からを作るのに失敗したら FAILED（鳴らしていた 1 文目は最後まで鳴らし、そこでやめる）', async (t) => {
  // [説明, エンジンの応え方]
  const cases = [
    ['2 文目の audio_query が失敗', { '/audio_query': { 2: fail(500) } }],
    ['2 文目の synthesis が失敗', { '/synthesis': { 2: fail(500) } }],
  ];
  for (const [label, plan] of cases) {
    const env = await setup(t, { plan });
    assert.equal(await env.voice.speak('一文目です。二文目です。三文目です。'), SpeakOutcome.FAILED, label);
    assert.deepEqual(env.played.map(({ text }) => text), ['WAV:一文目です。'], `${label}: 1 文目だけ鳴らす`);
    assert.equal(env.engine.count('/audio_query'), 2, `${label}: 3 文目は作らない`);
    assert.deepEqual(listDir(env.audioDir), [], `${label}: WAV を残さない`);
  }
});

test('鳴らすのに失敗したら FAILED（鳴らし始めているので FAILED_BEFORE_START にはしない）。作っておいた次の文の WAV も消す', async (t) => {
  // [説明, 偽の afplay の失敗のしかた]
  const cases = [
    ['afplay が失敗で終わる', (child) => child.finish(1)],
    ['afplay を起動できない', (child) => child.emit('error', new Error('ENOENT: injected by test'))],
  ];
  for (const [label, failure] of cases) {
    const env = await setup(t);
    const held = [];
    fake.onSpawn = (child) => held.push(child);
    const speaking = env.voice.speak('一文目です。二文目です。');
    await h.waitFor(() => held.length === 1 && listDir(env.audioDir).length === 2, 5000, `${label}: 1 文目を鳴らしている間に、2 文目の WAV ができる`);
    failure(held[0]);
    assert.equal(await speaking, SpeakOutcome.FAILED, label);
    assert.equal(held.length, 1, `${label}: 2 文目は鳴らさない`);
    assert.deepEqual(listDir(env.audioDir), [], `${label}: 2 文目の WAV も消す`);
  }
});

test('鳴らしている途中で kill() すると、afplay を SIGKILL で止め、作りかけの次の文の要求を取りやめて STOPPED', async (t) => {
  const env = await setup(t, { plan: { '/synthesis': { 2: hold } } });
  const held = [];
  fake.onSpawn = (child) => held.push(child);
  const speaking = env.voice.speak('一文目です。二文目です。');
  await h.waitFor(() => held.length === 1 && env.engine.count('/synthesis') === 2, 5000, '1 文目を鳴らし、2 文目を作っている');

  env.voice.kill();

  assert.equal(await speaking, SpeakOutcome.STOPPED);
  assert.deepEqual(held[0].kills, ['SIGKILL']);
  await h.waitFor(() => env.engine.aborted.length === 1, 5000, 'エンジンに、要求の取りやめが届く');
  assert.deepEqual(env.engine.aborted.map(({ path: target, n }) => [target, n]), [['/synthesis', 2]]);
  assert.deepEqual(listDir(env.audioDir), []);
});

test('エンジンの応えを待っている間に kill() すると、その要求を取りやめて STOPPED（何も鳴らさない）', async (t) => {
  // [説明, エンジンの応え方, 待っている要求]
  const cases = [
    ['声の一覧を待っている間', { '/speakers': { 1: hold } }, ['/speakers', 1]],
    ['1 文目の WAV を作っている間', { '/synthesis': { 1: hold } }, ['/synthesis', 1]],
  ];
  for (const [label, plan, [target, n]] of cases) {
    const env = await setup(t, { plan });
    const speaking = env.voice.speak('一文目です。二文目です。');
    await h.waitFor(() => env.engine.count(target) === n, 5000, `${label}: エンジンが応えずに止まっている`);
    env.voice.kill();
    assert.equal(await speaking, SpeakOutcome.STOPPED, label);
    await h.waitFor(() => env.engine.aborted.length === 1, 5000, `${label}: エンジンに、要求の取りやめが届く`);
    assert.deepEqual(env.engine.aborted.map((request) => [request.path, request.n]), [[target, n]], label);
    assert.deepEqual(env.played, [], `${label}: 何も鳴らさない`);
    assert.deepEqual(listDir(env.audioDir), [], `${label}: WAV を残さない`);
  }
});

test('kill() してから speak() すると、エンジンに問い合わせずに STOPPED', async (t) => {
  const env = await setup(t);
  env.voice.kill();
  assert.equal(await env.voice.speak('読みます。'), SpeakOutcome.STOPPED);
  assert.deepEqual(env.engine.requests, []);
  assert.deepEqual(fake.spawned, []);
});

test('次の文に取りかかるとき（onSegment の中）に kill() すると、もうできていたその文の WAV を消して STOPPED', async (t) => {
  const env = await setup(t);
  const held = [];
  fake.onSpawn = (child) => held.push(child);
  const speaking = env.voice.speak('一文目です。二文目です。', {
    onSegment: (segment) => h.lookup({ '二文目です。': () => env.voice.kill() }, segment, () => {})(),
  });
  await h.waitFor(() => held.length === 1 && listDir(env.audioDir).length === 2, 5000, '1 文目を鳴らしている間に、2 文目の WAV ができる');
  held[0].finish(0);

  assert.equal(await speaking, SpeakOutcome.STOPPED);
  assert.equal(held.length, 1, '2 文目は鳴らさない');
  assert.deepEqual(listDir(env.audioDir), [], '2 文目の WAV も消す');
});

test('WAV は、鳴らし終えたらすぐに消す（次の文を鳴らし始めるときには、前の文の WAV はない）', async (t) => {
  const env = await setup(t);
  assert.equal(await env.voice.speak('一。二。三。'), SpeakOutcome.FINISHED);
  assert.equal(env.played.length, 3);
  assert.ok(env.played.every(({ file }) => path.dirname(file) === env.audioDir), 'WAV はデータフォルダの audio/ に置く');
  for (const index of [1, 2]) {
    const previous = path.basename(env.played[index - 1].file);
    assert.equal(env.played[index].filesAtPlay.includes(previous), false, `${index + 1} 文目を鳴らし始めるときに、${index} 文目の WAV はない`);
  }
  assert.deepEqual(listDir(env.audioDir), []);
});

test('WAV を消せないときは、そのまま残す（古くなってから片付ける）', async (t) => {
  const env = await setup(t);
  const restores = [];
  fake.onSpawn = (child) => {
    env.played.push(recordPlay(child));
    restores.push(h.hookFs('rmSync', { [child.args[0]]: { other: h.throws('EBUSY') } }));
    setImmediate(() => child.finish(0));
  };
  const outcome = await env.voice.speak('読みます。');
  restores.forEach((restore) => restore());
  assert.equal(outcome, SpeakOutcome.FINISHED);
  assert.deepEqual(listDir(env.audioDir), [path.basename(env.played[0].file)]);
});

test('読み始めるときに、1 時間より前の WAV を片付ける（WAV でないファイル、新しい WAV、調べられない WAV は残す）', async (t) => {
  const env = await setup(t);
  const hoursAgo = (hours) => new Date(Date.now() - hours * 60 * 60 * 1000);
  // [ファイル名, 更新した時刻, 残るか]
  const files = [
    ['00000000-0000-4000-8000-000000000001.wav', hoursAgo(2), false],
    ['00000000-0000-4000-8000-000000000002.wav', hoursAgo(0.5), true],
    ['00000000-0000-4000-8000-000000000003.wav', hoursAgo(2), true], // 調べられない（下で statSync を失敗させる）
    ['note.txt', hoursAgo(2), true],
  ];
  fs.mkdirSync(env.audioDir, { recursive: true });
  for (const [name, time] of files) {
    fs.writeFileSync(path.join(env.audioDir, name), '');
    fs.utimesSync(path.join(env.audioDir, name), time, time);
  }
  const restore = h.hookFs('statSync', { [path.join(env.audioDir, files[2][0])]: { other: h.throws('EBUSY') } });
  const outcome = await env.voice.speak('読みます。');
  restore();

  assert.equal(outcome, SpeakOutcome.FINISHED);
  assert.deepEqual(listDir(env.audioDir).sort(), files.filter(([, , kept]) => kept).map(([name]) => name).sort());
});

test('データフォルダが渡されないときは、WAV を OS の一時フォルダの voice-reply-audio に置く', async (t) => {
  const engine = await startFakeEngine(t);
  const played = [];
  fake.spawned.length = 0;
  fake.onSpawn = playInstantly(played);
  const tempAudioDir = path.join(os.tmpdir(), 'voice-reply-audio');
  t.after(() => fs.rmSync(tempAudioDir, { recursive: true, force: true }));

  const voice = aivisspeech.create({ VOICE_REPLY_AIVIS_URL: engine.url });
  assert.equal(await voice.speak('読みます。'), SpeakOutcome.FINISHED);
  assert.equal(path.dirname(played[0].file), tempAudioDir);
});

test('読むもの（文字か数字）がない文章は、エンジンに問い合わせずに FINISHED', async (t) => {
  // [文章]
  const texts = ['', '---。', '  \n  '];
  for (const text of texts) {
    const env = await setup(t);
    assert.equal(await env.voice.speak(text), SpeakOutcome.FINISHED, JSON.stringify(text));
    assert.deepEqual(env.engine.requests, [], JSON.stringify(text));
    assert.deepEqual(fake.spawned, [], JSON.stringify(text));
  }
});

test('VOICE_REPLY_AIVIS_STYLE は整数（負の数も）だけを使い、それ以外は初期値の 888753760（まお／ノーマル）にする', async (t) => {
  // 最初のスタイルを 1000 にしておく（設定のスタイルが入っていないと、1000 を使う）
  const env = await setup(t, { speakers: [{ styles: [{ id: 1000 }, { id: 12 }, { id: -5 }, { id: 7 }, { id: 888753760 }] }] });
  // [VOICE_REPLY_AIVIS_STYLE, 使うスタイル ID]
  const cases = [
    ['12', '12'],
    ['-5', '-5'],
    [' 7 ', '7'],
    ['1.5', '888753760'],
    ['abc', '888753760'],
    ['', '888753760'],
    [undefined, '888753760'],
    ['9007199254740993', '888753760'], // Number で正確に表せない大きさ
  ];
  for (const [style, expected] of cases) {
    const voice = aivisspeech.create({ CLAUDE_PLUGIN_DATA: env.dataDir, VOICE_REPLY_AIVIS_URL: env.engine.url, VOICE_REPLY_AIVIS_STYLE: style });
    assert.equal(await voice.speak('読みます。'), SpeakOutcome.FINISHED, String(style));
    assert.equal(env.engine.requests.at(-1).speaker, expected, String(style));
  }
});

test('VOICE_REPLY_AIVIS_SPEED は 0.5〜2.0 の数だけを使い、それ以外は初期値の 1.4 にする', async (t) => {
  const env = await setup(t);
  // [VOICE_REPLY_AIVIS_SPEED, synthesis に送る speedScale]
  const cases = [
    ['0.5', 0.5],
    ['2.0', 2],
    ['1.25', 1.25],
    ['1.3x', 1.3], // 数で始まっていれば、その数を使う（Number.parseFloat と同じ）
    ['0.49', 1.4],
    ['2.01', 1.4],
    ['abc', 1.4],
    ['', 1.4],
    [undefined, 1.4],
  ];
  for (const [speed, expected] of cases) {
    const voice = aivisspeech.create({ CLAUDE_PLUGIN_DATA: env.dataDir, VOICE_REPLY_AIVIS_URL: env.engine.url, VOICE_REPLY_AIVIS_SPEED: speed });
    assert.equal(await voice.speak('読みます。'), SpeakOutcome.FINISHED, String(speed));
    assert.equal(env.engine.requests.at(-1).query.speedScale, expected, String(speed));
  }
});

test('VOICE_REPLY_AIVIS_URL は http か https の URL だけを使い（末尾の / は除く）、それ以外は http://127.0.0.1:10101 にする', async (t) => {
  // 初期値の URL には、本物のエンジンが動いていることがあるので、fetch を記録するだけの偽物に差し替える
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = (url) => {
    asked.push(String(url));
    return Promise.reject(new Error('offline: injected by test'));
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  // [VOICE_REPLY_AIVIS_URL, 問い合わせる URL]
  const cases = [
    ['http://example.test:1234', 'http://example.test:1234/version'],
    ['http://example.test:1234///', 'http://example.test:1234/version'],
    ['https://example.test/engine/', 'https://example.test/engine/version'],
    ['ftp://example.test', 'http://127.0.0.1:10101/version'],
    ['not a url', 'http://127.0.0.1:10101/version'],
    ['', 'http://127.0.0.1:10101/version'],
    [undefined, 'http://127.0.0.1:10101/version'],
  ];
  for (const [url, expected] of cases) {
    asked.length = 0;
    assert.equal(await aivisspeech.create({ VOICE_REPLY_AIVIS_URL: url }).isAvailable(), false, String(url));
    assert.deepEqual(asked, [expected], String(url));
  }
});

test('1 秒に読む文字数は、測った点（0.8・1.0・1.2・1.5）の間を直線でつなぎ、0.8 より下は比例で下げ、1.5 より上は頭打ちにする', () => {
  // [VOICE_REPLY_AIVIS_SPEED, 1 秒に読む文字数（小数第 3 位まで）, 説明]
  const cases = [
    ['0.8', 5, '測った点'],
    ['1.0', 6.09, '測った点'],
    ['1.2', 7.08, '測った点'],
    ['1.5', 8.5, '測った点'],
    ['0.9', 5.545, '0.8 と 1.0 の間（5.00 と 6.09 のまん中）'],
    ['1.1', 6.585, '1.0 と 1.2 の間'],
    ['1.3', 7.553, '1.2 と 1.5 の間（7.08 + 1.42 × 1/3）'],
    ['1.4', 8.027, '初期値（7.08 + 1.42 × 2/3）'],
    ['0.6', 3.75, '0.8 より下は比例で下げる（5.00 × 0.6 ÷ 0.8）'],
    ['0.5', 3.125, '一番遅い（5.00 × 0.5 ÷ 0.8）'],
    ['1.6', 8.5, '1.5 より上は頭打ち'],
    ['2.0', 8.5, '一番速い（頭打ち）'],
  ];
  for (const [speed, expected, label] of cases) {
    const charsPerSecond = aivisspeech.create({ VOICE_REPLY_AIVIS_SPEED: speed }).charsPerSecond();
    assert.equal(Number(charsPerSecond.toFixed(3)), expected, `${speed}: ${label}`);
  }
});

test('isAvailable() は、エンジンの /version が 2xx で応えたときだけ true', async (t) => {
  const unreachable = await closedUrl();
  // [説明, エンジンの応え方, URL を差し替えるか, 結果]
  const cases = [
    ['応える', {}, {}, true],
    ['失敗を返す（500）', { '/version': { 1: fail(500) } }, {}, false],
    ['つながらない', {}, { VOICE_REPLY_AIVIS_URL: unreachable }, false],
  ];
  for (const [label, plan, extraEnv, expected] of cases) {
    const env = await setup(t, { plan, env: extraEnv });
    assert.equal(await env.voice.isAvailable(), expected, label);
  }
});
