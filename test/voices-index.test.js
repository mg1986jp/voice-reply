/**
 * 声の選び方（scripts/voices/index.js）のテスト
 *   node --test test/*.test.js
 *
 * エンジンは、テストの中で動く偽物（test/fixtures/fake-engine.js）を使う。本物のエンジンにはつながない。
 * child_process.spawn を偽物（test/fixtures/fake-spawn.js）に差し替えるので、声も音も出ない。
 * OS は Mac にそろえる（OS の声は say、AivisSpeech の音は afplay）。どの OS でも同じ確かめ方にするため。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { startFakeEngine, closedUrl, fail, hold } = require('./fixtures/fake-engine');

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const setPlatform = (value) => Object.defineProperty(process, 'platform', { ...realPlatform, value });
setPlatform('darwin');
const fake = require('./fixtures/fake-spawn').install();
// spawn を差し替えたあとに読み込む（声と再生のモジュールは、読み込んだ時点で spawn を受け取る）
const { getOsVoice, chooseVoice } = require('../scripts/voices');

const finishSoon = (child) => setImmediate(() => child.finish(0));
/** 偽の afplay の動き: 起動できたこと（spawn）を知らせてから、すぐに鳴らし終えたことにする */
const playSoon = (child) => setImmediate(() => {
  child.emit('spawn');
  child.finish(0);
});
/** 偽の afplay の動き: 起動できない（spawn は来ず、error だけが来る） */
const cannotStart = (child) => setImmediate(() => child.emit('error', new Error('ENOENT: injected by test')));
/** 偽の say と afplay の動き: say は文章を受け取ったら、afplay は起動したら、すぐに読み終えた（鳴らし終えた）ことにする */
const INSTANT = { say: (child) => child.once('input-end', () => finishSoon(child)), afplay: playSoon };
/** 偽の子プロセスの記録を空にし、command ごとの動きを決める（表にない command は、止められるまで終わらない） */
function resetSpawn(behaviors) {
  fake.spawned.length = 0;
  fake.onSpawn = (child) => h.lookup(behaviors, child.command, () => {})(child);
}
const spawnedBy = (command) => fake.spawned.filter((child) => child.command === command);
/** 声の種類（クラスの名前）。声がなければ null */
const nameOf = (voice) => voice && voice.constructor.name;

test('getOsVoice() は OS の声を返す（Mac は say、Windows は SAPI の声）。読み上げが動かない OS では null', (t) => {
  t.after(() => setPlatform('darwin'));
  // [OS, 声の種類]
  const cases = [
    ['darwin', 'MacSay'],
    ['win32', 'WindowsSapi'],
    ['linux', null],
  ];
  for (const [platform, expected] of cases) {
    setPlatform(platform);
    assert.equal(nameOf(getOsVoice()), expected, platform);
  }
});

test('読み上げが動かない OS では、chooseVoice() はエンジンに問い合わせずに null', async (t) => {
  const engine = await startFakeEngine(t);
  t.after(() => setPlatform('darwin'));
  setPlatform('linux');
  assert.equal(await chooseVoice({ VOICE_REPLY_AIVIS_URL: engine.url }), null);
  assert.equal(await chooseVoice(), null, '環境変数を渡さないときは process.env を使う');
  assert.deepEqual(engine.requests, []);
});

test('chooseVoice() に環境変数を渡さないときは、process.env の設定で選ぶ', async (t) => {
  // os にしておく（エンジンに問い合わせない。初期値の URL には本物のエンジンが動いていることがあるため）
  const saved = process.env.VOICE_REPLY_ENGINE;
  process.env.VOICE_REPLY_ENGINE = 'os';
  // 終わったら元に戻す（もともとなければ消す。process.env に undefined を入れると文字列の "undefined" になるため）
  t.after(() => {
    delete process.env.VOICE_REPLY_ENGINE;
    Object.assign(process.env, h.lookup({ undefined: {} }, String(saved), { VOICE_REPLY_ENGINE: saved }));
  });
  assert.equal(nameOf(await chooseVoice()), 'MacSay');
});

test('VOICE_REPLY_ENGINE で声を選ぶ。auto（初期値。決まりに合わない値も）は、エンジンが応えれば AivisSpeech、応えなければ OS の声', async (t) => {
  const unreachable = await closedUrl();
  // エンジンの様子: { エンジンの応え方, 声につながせる URL }
  const STATES = {
    up: { plan: {}, url: (engine) => engine.url },
    error: { plan: { '/version': { 1: fail(500) } }, url: (engine) => engine.url },
    down: { plan: {}, url: () => unreachable },
  };
  // [説明, VOICE_REPLY_ENGINE, エンジンの様子, 選ぶ声, /version への問い合わせの数]
  const cases = [
    ['auto でエンジンが応える → AivisSpeech（失敗したら OS の声に切り替える）', 'auto', 'up', 'AivisSpeechWithFallback', 1],
    ['設定がなければ auto', undefined, 'up', 'AivisSpeechWithFallback', 1],
    ['大文字や前後の空白は気にしない', ' AUTO ', 'up', 'AivisSpeechWithFallback', 1],
    ['決まりに合わない値は auto', 'say', 'up', 'AivisSpeechWithFallback', 1],
    ['auto でエンジンが失敗を返す（500） → OS の声', 'auto', 'error', 'MacSay', 1],
    ['auto でエンジンにつながらない → OS の声', 'auto', 'down', 'MacSay', 0],
    ['aivisspeech は、エンジンに問い合わせずに AivisSpeech（OS の声に切り替えない）', 'aivisspeech', 'down', 'AivisSpeech', 0],
    ['大文字の AivisSpeech も aivisspeech', 'AivisSpeech', 'up', 'AivisSpeech', 0],
    ['os は、エンジンに問い合わせずに OS の声', 'os', 'up', 'MacSay', 0],
  ];
  for (const [label, engineName, stateName, expected, probes] of cases) {
    const state = STATES[stateName];
    const engine = await startFakeEngine(t, { plan: state.plan });
    const voice = await chooseVoice({ VOICE_REPLY_ENGINE: engineName, VOICE_REPLY_AIVIS_URL: state.url(engine) });
    assert.equal(nameOf(voice), expected, label);
    assert.equal(engine.count('/version'), probes, `${label}: /version への問い合わせ`);
  }
});

test('auto でエンジンが応えないまま 1.5 秒たったら、待つのをやめて OS の声にする', async (t) => {
  const engine = await startFakeEngine(t, { plan: { '/version': { other: hold } } });
  const started = Date.now();
  const voice = await chooseVoice({ VOICE_REPLY_AIVIS_URL: engine.url });
  const elapsed = Date.now() - started;
  assert.equal(nameOf(voice), 'MacSay');
  assert.ok(elapsed >= 1400 && elapsed < 3000, `${elapsed}ms で OS の声にした`);
  await h.waitFor(() => engine.aborted.length === 1, 5000, '応えを待つのをやめたら、問い合わせを取りやめる');
});

test('AivisSpeech の音を鳴らす afplay を起動できなかったら（まだ何も聞こえていない）、OS の声で最初から全部読む', async (t) => {
  const engine = await startFakeEngine(t);
  resetSpawn({ say: INSTANT.say, afplay: cannotStart });
  const voice = await chooseVoice({ CLAUDE_PLUGIN_DATA: h.makeWorkDir(t), VOICE_REPLY_AIVIS_URL: engine.url });
  const segments = [];
  await voice.speak('一文目です。二文目です。', { onSegment: (segment, by) => segments.push([segment, nameOf(by)]) });
  assert.deepEqual(segments, [['一文目です。', 'AivisSpeech'], ['一文目です。二文目です。', 'MacSay']]);
  assert.equal(spawnedBy('afplay').length, 1, 'AivisSpeech は 1 文目を鳴らそうとした');
  assert.deepEqual(spawnedBy('say').map((child) => child.input), ['一文目です。二文目です。'], 'OS の声で全部読む');
});

test('AivisSpeech が 1 文目を鳴らし始める前に失敗したら、OS の声で最初から全部読む（onSegment は、読み直す OS の声で全体をもう一度呼ぶ）', async (t) => {
  const engine = await startFakeEngine(t, { plan: { '/audio_query': { 1: fail(500) } } });
  resetSpawn(INSTANT);
  const voice = await chooseVoice({ CLAUDE_PLUGIN_DATA: h.makeWorkDir(t), VOICE_REPLY_AIVIS_URL: engine.url });
  const segments = [];
  await voice.speak('一文目です。二文目です。', { onSegment: (segment, by) => segments.push([segment, nameOf(by)]) });
  assert.deepEqual(segments, [['一文目です。', 'AivisSpeech'], ['一文目です。二文目です。', 'MacSay']]);
  assert.deepEqual(spawnedBy('say').map((child) => child.input), ['一文目です。二文目です。'], 'OS の声で全部読む');
  assert.deepEqual(spawnedBy('afplay'), [], 'AivisSpeech では何も鳴らしていない');
});

test('AivisSpeech が読んでいる途中で失敗したら、そこでやめ、OS の声で読み直さない', async (t) => {
  const engine = await startFakeEngine(t, { plan: { '/audio_query': { 2: fail(500) } } });
  resetSpawn(INSTANT);
  const voice = await chooseVoice({ CLAUDE_PLUGIN_DATA: h.makeWorkDir(t), VOICE_REPLY_AIVIS_URL: engine.url });
  const segments = [];
  await voice.speak('一文目です。二文目です。', { onSegment: (segment, by) => segments.push([segment, nameOf(by)]) });
  assert.deepEqual(segments, [['一文目です。', 'AivisSpeech'], ['二文目です。', 'AivisSpeech']]);
  assert.equal(spawnedBy('afplay').length, 1, '1 文目だけ鳴らす');
  assert.deepEqual(spawnedBy('say'), [], 'OS の声で読み直さない');
});

test('AivisSpeech で読んでいる間に kill() すると、AivisSpeech を止め、OS の声には切り替えない', async (t) => {
  const engine = await startFakeEngine(t);
  // afplay は起動できたこと（spawn）だけを知らせ、止められるまで鳴らし終えない
  resetSpawn({ say: INSTANT.say, afplay: (child) => setImmediate(() => child.emit('spawn')) });
  const voice = await chooseVoice({ CLAUDE_PLUGIN_DATA: h.makeWorkDir(t), VOICE_REPLY_AIVIS_URL: engine.url });
  const speaking = voice.speak('一文目です。二文目です。');
  await h.waitFor(() => spawnedBy('afplay').length === 1, 5000, 'AivisSpeech が 1 文目を鳴らし始める');

  voice.kill();

  await speaking;
  assert.deepEqual(spawnedBy('afplay')[0].kills, ['SIGKILL']);
  assert.deepEqual(spawnedBy('say'), [], 'OS の声に切り替えない');
});

test('OS の声に切り替えたあとに kill() すると、OS の声を止める', async (t) => {
  const engine = await startFakeEngine(t, { plan: { '/audio_query': { 1: fail(500) } } });
  resetSpawn({}); // say は、止められるまで読み終えない
  const voice = await chooseVoice({ CLAUDE_PLUGIN_DATA: h.makeWorkDir(t), VOICE_REPLY_AIVIS_URL: engine.url });
  const speaking = voice.speak('一文目です。二文目です。');
  await h.waitFor(() => spawnedBy('say').length === 1, 5000, 'OS の声に切り替えて読み始める');

  voice.kill();

  await speaking;
  assert.deepEqual(spawnedBy('say')[0].kills, ['SIGKILL']);
  assert.equal(spawnedBy('say')[0].input, '一文目です。二文目です。');
});
