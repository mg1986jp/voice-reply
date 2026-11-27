/**
 * Mac の声（scripts/voices/mac-say.js）のテスト: 速さの設定から 1 秒に読む文字数を見積もる、say の起動のしかた
 *   node --test test/*.test.js
 *
 * child_process.spawn を偽物（test/fixtures/fake-spawn.js）に差し替えてから読み込むので、say は起動せず、声も出ない。Mac 以外でも動く。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const fake = require('./fixtures/fake-spawn').install();
// spawn を差し替えたあとに読み込む（mac-say.js は読み込んだ時点で spawn を受け取る）
const macSay = require('../scripts/voices/mac-say');

const charsPerSecondAt = (rate) => macSay.create({ VOICE_REPLY_MAC_RATE: rate }).charsPerSecond();

test('1 秒に読む文字数は、-r 260 で 8、-r に比例し、770 で頭打ち。正の整数でない -r は初期値の 260 として見積もる', () => {
  // [VOICE_REPLY_MAC_RATE の値, 1 秒に読む文字数（小数第 3 位まで）, 説明]
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
  // [VOICE_REPLY_MAC_RATE の値]
  const aboveCap = ['771', '1000', '5000'];
  for (const rate of aboveCap) {
    assert.equal(charsPerSecondAt(rate), charsPerSecondAt('770'), rate);
  }
});

test('speak() は、全体を 1 つの区切りとして onSegment(文章, この声) を 1 回呼んでから say を起動し、文章を標準入力で渡す', async () => {
  fake.spawned.length = 0;
  fake.onSpawn = (child) => child.once('input-end', () => setImmediate(() => child.finish(0)));
  // [環境変数, say の引数, 説明]
  const cases = [
    [{ VOICE_REPLY_MAC_VOICE: 'Otoya', VOICE_REPLY_MAC_RATE: '300' }, ['-v', 'Otoya', '-r', '300'], '声と速さの設定を渡す'],
    [{}, ['-v', 'Kyoko', '-r', '260'], '設定がなければ Kyoko と 260'],
    [{ CLAUDE_SAY_VOICE: 'Otoya', CLAUDE_SAY_RATE: '520' }, ['-v', 'Kyoko', '-r', '260'], '古い名前（CLAUDE_SAY_*）は読まない'],
  ];
  for (const [env, args, label] of cases) {
    fake.spawned.length = 0;
    const voice = macSay.create(env);
    const segments = [];
    await voice.speak('読みます。', { onSegment: (segment, by) => segments.push([segment, by === voice, fake.spawned.length]) });
    assert.deepEqual(segments, [['読みます。', true, 0]], `${label}: say を起動する前に 1 回だけ呼ぶ`);
    assert.deepEqual(fake.spawned.map((child) => [child.command, child.args, child.input]), [['say', args, '読みます。']], label);
  }
});

test('speak() は onSegment を渡さなくても読め、kill() で say を SIGKILL で止める。止まっていれば、もう止めない', async () => {
  fake.spawned.length = 0;
  fake.onSpawn = () => {}; // say は、止められるまで読み終えない
  const voice = macSay.create({});
  const speaking = voice.speak('読みます。');
  await h.waitFor(() => fake.spawned.length === 1 && fake.spawned[0].input === '読みます。', 5000, 'say が文章を受け取る');
  voice.kill();
  await speaking;
  voice.kill();
  assert.deepEqual(fake.spawned[0].kills, ['SIGKILL']);
});

test('say を起動できなかったとき（error）も読み終えたことにし、say が先に終わって標準入力に書けなくても（EPIPE）例外にしない', async () => {
  fake.spawned.length = 0;
  fake.onSpawn = (child) => setImmediate(() => {
    child.stdin.emit('error', new Error('EPIPE: injected by test'));
    child.emit('error', new Error('ENOENT: injected by test'));
  });
  await macSay.create({}).speak('読みます。');
  assert.equal(fake.spawned.length, 1);
});
