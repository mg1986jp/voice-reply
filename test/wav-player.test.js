/**
 * WAV を鳴らす処理（scripts/lib/wav-player.js）のテスト
 *   node --test test/*.test.js
 *
 * child_process.spawn を偽物（test/fixtures/fake-spawn.js）に差し替えてから読み込むので、本物の音は出ない。
 * Windows の鳴らし方も Mac の鳴らし方も、どちらの OS でも確かめられる。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const h = require('./helpers');
const fake = require('./fixtures/fake-spawn').install();
// spawn を差し替えたあとに読み込む（wav-player.js は読み込んだ時点で spawn を受け取る）
const { createWavPlayer } = require('../scripts/lib/wav-player');
const { WIN_POWERSHELL } = require('../scripts/lib/windows');

/** 偽の子プロセスの記録を空にし、動きを決める */
function resetSpawn(onSpawn = () => {}) {
  fake.spawned.length = 0;
  fake.onSpawn = onSpawn;
}
/** PowerShell に -EncodedCommand で渡した再生のスクリプト */
const decodeScript = (child) => Buffer.from(child.args[child.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
/** 子プロセスの標準出力が、読む側に届くまで待つ（イベントループを 1 回まわす） */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('OS ごとの鳴らし方を返す。Windows は作った時点で PowerShell を起動し、Mac は鳴らすまで何も起動しない。ほかの OS では null', () => {
  // [OS, 作った時点で起動したコマンド]
  const cases = [
    ['win32', [WIN_POWERSHELL]],
    ['darwin', []],
  ];
  for (const [platform, commands] of cases) {
    resetSpawn();
    const player = createWavPlayer(platform);
    assert.deepEqual(fake.spawned.map((child) => child.command), commands, platform);
    player.close();
  }
  assert.equal(createWavPlayer('linux'), null);
});

test('Windows: Windows PowerShell 5.1 を窓を出さずに起動し、標準入力から 1 行ずつ WAV のパスを読んで SoundPlayer で鳴らすスクリプトを渡す', () => {
  resetSpawn();
  const player = createWavPlayer('win32');
  const child = fake.spawned[0];
  assert.deepEqual(child.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.deepEqual(child.options, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const script = decodeScript(child);
  // [スクリプトに入っているはずのもの, 説明]
  const expectations = [
    ['[System.Text.UTF8Encoding]::new($false)', '標準入力を UTF-8 で読む（日本語のパスが化けないように）'],
    ['$reader.ReadLine()', '1 行ずつ読む'],
    ['New-Object System.Media.SoundPlayer $file', 'SoundPlayer で鳴らす'],
    ['$player.PlaySync()', '鳴らし終えるまで待つ'],
    ["[Console]::Out.WriteLine('played')", '鳴らし終えたら played と書く'],
  ];
  for (const [fragment, label] of expectations) {
    assert.ok(script.includes(fragment), label);
  }
  player.close();
});

test('Windows: WAV のパスを 1 行ずつ渡し、played が返るたびに、1 つずつ最後まで鳴らしたことにする', async () => {
  resetSpawn();
  const player = createWavPlayer('win32');
  const child = fake.spawned[0];

  const first = h.track(player.play('C:\\データ\\一.wav'));
  assert.equal(child.input, 'C:\\データ\\一.wav\n');
  child.stdout.write('noise\n');
  child.stdout.write('pla');
  await flush();
  assert.equal(first.settled, false, 'played 以外の行や、途中までの行では、まだ鳴らし終えていない');
  child.stdout.write('yed\n');
  assert.equal(await first.promise, true);

  const second = player.play('C:\\データ\\二.wav');
  assert.equal(child.input, 'C:\\データ\\一.wav\nC:\\データ\\二.wav\n', '次の WAV は、前の WAV を鳴らし終えてから渡す');
  child.stdout.write('played\r\n');
  assert.equal(await second, true, 'Windows の改行（CRLF）でも読める');
  player.close();
});

test('Windows: stop() は PowerShell を止めて音をすぐに止め、このあとの play() は鳴らさない。止まっていれば、もう止めない', async () => {
  resetSpawn();
  const player = createWavPlayer('win32');
  const child = fake.spawned[0];
  const playing = player.play('a.wav');
  player.stop();
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(await playing, false);
  assert.equal(await player.play('b.wav'), false);
  assert.equal(child.input, 'a.wav\n', 'stop() のあとは WAV を渡さない');
  player.stop();
  assert.deepEqual(child.kills, ['SIGTERM'], '2 回目の stop() では止めない');
});

test('Windows: close() は標準入力を閉じる。PowerShell が終わったあとは鳴らさない', async () => {
  resetSpawn();
  const player = createWavPlayer('win32');
  const child = fake.spawned[0];
  const ended = once(child, 'input-end');
  player.close();
  await ended;
  child.finish(0); // 鳴らしている WAV がないときに終わっても困らない
  assert.equal(await player.play('c.wav'), false);
  assert.equal(child.input, '', '終わったあとは WAV を渡さない');
});

test('Windows: PowerShell が失敗したら（起動できない、途中で終わる）、鳴らしている WAV は false で終わり、このあとも鳴らさない', async () => {
  // [説明, 失敗のしかた]
  const cases = [
    ['起動できない', (child) => child.emit('error', new Error('ENOENT: injected by test'))],
    ['WAV を読めずに終わる', (child) => child.finish(1)],
  ];
  for (const [label, failure] of cases) {
    resetSpawn();
    const player = createWavPlayer('win32');
    const child = fake.spawned[0];
    const playing = player.play('x.wav');
    failure(child);
    assert.equal(await playing, false, label);
    assert.equal(await player.play('y.wav'), false, `${label}: このあとも鳴らさない`);
    // PowerShell が先に終わって、標準入力に書けなかったとき（EPIPE）も、例外にしない
    child.stdin.emit('error', new Error('EPIPE: injected by test'));
  }
});

test('Mac: WAV ごとに afplay を起動し、終了コード 0 なら最後まで鳴らしたことにする。起動できない、失敗で終わるときは false', async () => {
  // [WAV, 偽の afplay の終わり方]
  const endings = {
    'ok.wav': (child) => child.finish(0),
    'bad.wav': (child) => child.finish(1),
    'missing.wav': (child) => child.emit('error', new Error('ENOENT: injected by test')),
  };
  resetSpawn((child) => setImmediate(() => endings[child.args[0]](child)));
  const player = createWavPlayer('darwin');
  // [WAV, 最後まで鳴らしたか]
  const cases = [
    ['ok.wav', true],
    ['bad.wav', false],
    ['missing.wav', false],
  ];
  for (const [file, expected] of cases) {
    assert.equal(await player.play(file), expected, file);
  }
  assert.deepEqual(
    fake.spawned.map((child) => [child.command, child.args, child.options]),
    cases.map(([file]) => ['afplay', [file], { stdio: 'ignore' }]),
  );
  player.stop();
  assert.deepEqual(fake.spawned[0].kills, [], '鳴らし終えた afplay は止めない');
});

test('Mac: stop() は鳴らしている afplay を SIGKILL で止め、このあとの play() は afplay を起動しない。鳴らす前の stop() と close() は何もしない', async () => {
  resetSpawn(); // 偽の afplay は、止められるまで鳴らし終えない
  const idle = createWavPlayer('darwin');
  idle.close();
  idle.stop();
  assert.equal(await idle.play('x.wav'), false);
  assert.equal(fake.spawned.length, 0, '鳴らす前に止めたら、afplay を起動しない');

  const player = createWavPlayer('darwin');
  const playing = player.play('a.wav');
  player.stop();
  assert.deepEqual(fake.spawned[0].kills, ['SIGKILL']);
  assert.equal(await playing, false);
  player.stop();
  assert.deepEqual(fake.spawned[0].kills, ['SIGKILL'], '止まっていれば、もう止めない');
  assert.equal(await player.play('b.wav'), false);
  assert.equal(fake.spawned.length, 1, 'stop() のあとは afplay を起動しない');
});
