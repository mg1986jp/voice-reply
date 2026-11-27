/**
 * Windows の声（scripts/voices/windows-sapi.js）のテスト: 速さの設定から 1 秒に読む文字数を見積もる、PowerShell の起動のしかた
 *   node --test test/*.test.js
 *
 * child_process.spawn を偽物（test/fixtures/fake-spawn.js）に差し替えてから読み込むので、PowerShell は起動せず、声も出ない。Windows 以外でも動く。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const fake = require('./fixtures/fake-spawn').install();
// spawn を差し替えたあとに読み込む（windows-sapi.js は読み込んだ時点で spawn を受け取る）
const windowsSapi = require('../scripts/voices/windows-sapi');
const { WIN_POWERSHELL } = require('../scripts/lib/windows');

/** PowerShell に -EncodedCommand で渡した読み上げのスクリプト */
const decodeScript = (child) => Buffer.from(child.args[child.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

test('1 秒に読む文字数は、Rate 3 で 8、Rate が 1 上がるごとに 1.116 倍。決まりに合わない Rate は初期値の 3 として見積もる', () => {
  // [VOICE_REPLY_WIN_RATE の値, 1 秒に読む文字数（小数第 3 位まで）, 説明]
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
    const charsPerSecond = windowsSapi.create({ VOICE_REPLY_WIN_RATE: rate }).charsPerSecond();
    assert.equal(Number(charsPerSecond.toFixed(3)), expected, `${rate}: ${label}`);
  }
});

test('speak() は onSegment(文章, この声) を 1 回呼んでから PowerShell を窓を出さずに起動し、声と速さを環境変数で、文章を標準入力で渡す', async () => {
  fake.onSpawn = (child) => child.once('input-end', () => setImmediate(() => child.finish(0)));
  // [環境変数, PowerShell に渡す声, PowerShell に渡す速さ, 説明]
  const cases = [
    [{ VOICE_REPLY_WIN_VOICE: 'Microsoft Ayumi Desktop', VOICE_REPLY_WIN_RATE: '5' }, 'Microsoft Ayumi Desktop', '5', '声と速さの設定を渡す'],
    [{}, 'Microsoft Haruka Desktop', '3', '設定がなければ Haruka と 3'],
    [{ VOICE_REPLY_MAC_VOICE: 'Kyoko' }, 'Microsoft Haruka Desktop', '3', 'Mac の声の名前（VOICE_REPLY_MAC_VOICE）は使わない'],
    [{ CLAUDE_SAY_VOICE: 'Microsoft Ayumi Desktop', CLAUDE_SAY_WIN_RATE: '5' }, 'Microsoft Haruka Desktop', '3', '古い名前（CLAUDE_SAY_*）は読まない'],
  ];
  for (const [env, sapiVoice, sapiRate, label] of cases) {
    fake.spawned.length = 0;
    const voice = windowsSapi.create(env);
    const segments = [];
    await voice.speak('読みます。', { onSegment: (segment, by) => segments.push([segment, by === voice, fake.spawned.length]) });
    assert.deepEqual(segments, [['読みます。', true, 0]], `${label}: PowerShell を起動する前に 1 回だけ呼ぶ`);
    const [child] = fake.spawned;
    assert.equal(child.command, WIN_POWERSHELL, label);
    assert.deepEqual(child.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand'], label);
    assert.equal(child.options.windowsHide, true, label);
    assert.deepEqual([child.options.env.VOICE_REPLY_SAPI_VOICE, child.options.env.VOICE_REPLY_SAPI_RATE], [sapiVoice, sapiRate], label);
    assert.equal(child.input, '読みます。', label);
  }
});

test('読み上げのスクリプトは、環境変数 VOICE_REPLY_SAPI_VOICE と VOICE_REPLY_SAPI_RATE で声と速さを受け取る', async () => {
  fake.spawned.length = 0;
  fake.onSpawn = (child) => child.once('input-end', () => setImmediate(() => child.finish(0)));
  await windowsSapi.create({}).speak('読みます。');
  const script = decodeScript(fake.spawned[0]);
  // [スクリプトに入っているはずのもの]
  const fragments = ['$_.Name -eq $env:VOICE_REPLY_SAPI_VOICE', '$synth.Rate = [int]$env:VOICE_REPLY_SAPI_RATE'];
  for (const fragment of fragments) {
    assert.ok(script.includes(fragment), fragment);
  }
});

test('speak() は onSegment を渡さなくても読め、kill() で PowerShell を止める。止まっていれば、もう止めない', async () => {
  fake.spawned.length = 0;
  fake.onSpawn = () => {}; // PowerShell は、止められるまで読み終えない
  const voice = windowsSapi.create({});
  const speaking = voice.speak('読みます。');
  await h.waitFor(() => fake.spawned.length === 1 && fake.spawned[0].input === '読みます。', 5000, 'PowerShell が文章を受け取る');
  voice.kill();
  await speaking;
  voice.kill();
  assert.deepEqual(fake.spawned[0].kills, ['SIGTERM']);
});

test('PowerShell を起動できなかったとき（error）も読み終えたことにし、PowerShell が先に終わって標準入力に書けなくても（EPIPE）例外にしない', async () => {
  fake.spawned.length = 0;
  fake.onSpawn = (child) => setImmediate(() => {
    child.stdin.emit('error', new Error('EPIPE: injected by test'));
    child.emit('error', new Error('ENOENT: injected by test'));
  });
  await windowsSapi.create({}).speak('読みます。');
  assert.equal(fake.spawned.length, 1);
});
