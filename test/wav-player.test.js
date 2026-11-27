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
/** play() の結果: 鳴らさなかった（音を鳴らし始めてもいない） */
const NOT_PLAYED = { played: false, started: false };

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
    ["$ascii.GetString($header, 0, 4) -ne 'RIFF'", 'WAV の形（先頭の RIFF）を確かめる'],
    ["$ascii.GetString($header, 8, 4) -ne 'WAVE'", 'WAV の形（WAVE）を確かめる'],
  ];
  for (const [fragment, label] of expectations) {
    assert.ok(script.includes(fragment), label);
  }
  // 読み込む → WAV の形を確かめる → started と書く → 鳴らす → played と書く、の順
  const steps = ['$player.Load()', "-ne 'WAVE'", "[Console]::Out.WriteLine('started')", '$player.PlaySync()', "[Console]::Out.WriteLine('played')"];
  const positions = steps.map((step) => script.indexOf(step));
  assert.ok(positions.every((position) => position >= 0), 'どの手順もスクリプトにある');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, '手順がこの順に並んでいる');
  player.close();
});

test('Windows: WAV のパスを 1 行ずつ渡し、started のあとに played が返るたびに、1 つずつ最後まで鳴らしたことにする', async () => {
  resetSpawn();
  const player = createWavPlayer('win32');
  const child = fake.spawned[0];

  const first = h.track(player.play('C:\\データ\\一.wav'));
  assert.equal(child.input, 'C:\\データ\\一.wav\n');
  child.stdout.write('started\n');
  child.stdout.write('noise\n');
  child.stdout.write('pla');
  await flush();
  assert.equal(first.settled, false, 'started や played 以外の行、途中までの行では、まだ鳴らし終えていない');
  child.stdout.write('yed\n');
  assert.deepEqual(await first.promise, { played: true, started: true });

  const second = player.play('C:\\データ\\二.wav');
  assert.equal(child.input, 'C:\\データ\\一.wav\nC:\\データ\\二.wav\n', '次の WAV は、前の WAV を鳴らし終えてから渡す');
  child.stdout.write('started\r\nplayed\r\n');
  assert.deepEqual(await second, { played: true, started: true }, 'Windows の改行（CRLF）でも読める');
  player.close();
});

test('Windows: started の前に PowerShell が失敗したら（起動できない、読み込めない・WAV の形でない）started は false、started のあとなら true。どちらも played は false で、このあとも鳴らさない', async () => {
  // [説明, 失敗のしかた, play() の結果]
  const cases = [
    ['起動できない', async (child) => child.emit('error', new Error('ENOENT: injected by test')), NOT_PLAYED],
    ['started を書く前に終わる（読み込めない、WAV の形でない）', async (child) => child.finish(1), NOT_PLAYED],
    ['started を書いたあとに終わる（鳴らしている途中の失敗）', async (child) => {
      child.stdout.write('started\n');
      await flush();
      child.finish(1);
    }, { played: false, started: true }],
  ];
  for (const [label, failure, expected] of cases) {
    resetSpawn();
    const player = createWavPlayer('win32');
    const child = fake.spawned[0];
    const playing = player.play('x.wav');
    await failure(child);
    assert.deepEqual(await playing, expected, label);
    assert.deepEqual(await player.play('y.wav'), NOT_PLAYED, `${label}: このあとも鳴らさない`);
    // PowerShell が先に終わって、標準入力に書けなかったとき（EPIPE）も、例外にしない
    child.stdin.emit('error', new Error('EPIPE: injected by test'));
  }
});

test('Windows: stop() は PowerShell を止めて音をすぐに止め、このあとの play() は鳴らさない。止まっていれば、もう止めない', async () => {
  resetSpawn();
  const player = createWavPlayer('win32');
  const child = fake.spawned[0];
  const playing = player.play('a.wav');
  child.stdout.write('started\n');
  await flush();
  player.stop();
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.deepEqual(await playing, { played: false, started: true }, '鳴らし始めていた音を止めた');
  assert.deepEqual(await player.play('b.wav'), NOT_PLAYED);
  assert.equal(child.input, 'a.wav\n', 'stop() のあとは WAV を渡さない');
  player.stop();
  assert.deepEqual(child.kills, ['SIGTERM'], '2 回目の stop() では止めない');
});

test('Windows: close() は標準入力を閉じる。PowerShell が終わったあとは鳴らさない。鳴らしていないときに started が届いても困らない', async () => {
  resetSpawn();
  const player = createWavPlayer('win32');
  const child = fake.spawned[0];
  child.stdout.write('started\n');
  await flush();
  const ended = once(child, 'input-end');
  player.close();
  await ended;
  child.finish(0); // 鳴らしている WAV がないときに終わっても困らない
  assert.deepEqual(await player.play('c.wav'), NOT_PLAYED);
  assert.equal(child.input, '', '終わったあとは WAV を渡さない');
});

test('Mac: WAV ごとに afplay を起動し、起動できたら鳴らし始めたことにし、終了コード 0 なら最後まで鳴らしたことにする', async () => {
  // [WAV, 偽の afplay の動き]
  const endings = {
    'ok.wav': (child) => {
      child.emit('spawn');
      child.finish(0);
    },
    'bad.wav': (child) => {
      child.emit('spawn');
      child.finish(1);
    },
    'missing.wav': (child) => child.emit('error', new Error('ENOENT: injected by test')),
  };
  resetSpawn((child) => setImmediate(() => endings[child.args[0]](child)));
  const player = createWavPlayer('darwin');
  // [WAV, play() の結果, 説明]
  const cases = [
    ['ok.wav', { played: true, started: true }, '起動して、終了コード 0 で終わる'],
    ['bad.wav', { played: false, started: true }, '起動したが、失敗で終わる'],
    ['missing.wav', NOT_PLAYED, '起動できない（spawn は来ず、error だけが来る）'],
  ];
  for (const [file, expected, label] of cases) {
    assert.deepEqual(await player.play(file), expected, label);
  }
  assert.deepEqual(
    fake.spawned.map((child) => [child.command, child.args, child.options]),
    cases.map(([file]) => ['afplay', [file], { stdio: 'ignore' }]),
  );

  // 鳴らし終えた afplay を「今の子」にしてから stop() を呼んでも、その子は止めない
  assert.deepEqual(await player.play('ok.wav'), { played: true, started: true });
  const finished = fake.spawned[fake.spawned.length - 1];
  player.stop();
  assert.deepEqual(finished.kills, [], '鳴らし終えた今の afplay は止めない');
});

test('Mac: stop() は鳴らしている afplay を SIGKILL で止め、このあとの play() は afplay を起動しない。鳴らす前の stop() と close() は何もしない', async () => {
  // 偽の afplay は、起動できたこと（spawn）だけを知らせ、止められるまで鳴らし終えない
  resetSpawn((child) => setImmediate(() => child.emit('spawn')));
  const idle = createWavPlayer('darwin');
  idle.close();
  idle.stop();
  assert.deepEqual(await idle.play('x.wav'), NOT_PLAYED);
  assert.equal(fake.spawned.length, 0, '鳴らす前に止めたら、afplay を起動しない');

  const player = createWavPlayer('darwin');
  const playing = player.play('a.wav');
  await flush();
  player.stop();
  assert.deepEqual(fake.spawned[0].kills, ['SIGKILL']);
  assert.deepEqual(await playing, { played: false, started: true }, '鳴らし始めていた音を止めた');
  player.stop();
  assert.deepEqual(fake.spawned[0].kills, ['SIGKILL'], '止まっていれば、もう止めない');
  assert.deepEqual(await player.play('b.wav'), NOT_PLAYED);
  assert.equal(fake.spawned.length, 1, 'stop() のあとは afplay を起動しない');
});
