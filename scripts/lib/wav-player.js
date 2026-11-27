/**
 * WAV ファイルを鳴らす（声に依存しない。鳴らし方は OS ごとに違う）
 *
 *   createWavPlayer(platform)  OS に合う鳴らし方を返す。対応していない OS では null
 *
 * 返すものは、次の 3 つを持つ:
 *   play(file): Promise<boolean>  最後まで鳴らしたら true、止められたときや失敗したときは false で resolve する（reject しない）
 *   stop(): void                  鳴っている音をすぐに止め、このあとの play() も鳴らさない（自分の子プロセスだけを止める）
 *   close(): void                 もう鳴らさないことを伝え、子プロセスを終わらせる（鳴っている音は最後まで鳴らす）
 *
 * Windows: Windows PowerShell 5.1 を 1 つ起動したままにし、標準入力で受け取った WAV を System.Media.SoundPlayer で順に鳴らす。
 *          文ごとに PowerShell を起動すると、起動にかかる時間（0.2〜1 秒）が文と文の間に挟まるため。
 *          音は PowerShell のプロセスの中で鳴るので、プロセスを止めれば音も止まる
 * Mac:     WAV ごとに afplay を起動する（起動が速いので、文と文の間はほとんど空かない）
 */
'use strict';

const { spawn } = require('node:child_process');
const { WIN_POWERSHELL } = require('./windows');

/** 子プロセスがまだ動いているか */
function isRunning(proc) {
  return proc !== null && proc.exitCode === null && proc.signalCode === null;
}

/**
 * Windows PowerShell 5.1 に -EncodedCommand で渡す再生のスクリプト
 *
 * - WAV のパスを標準入力から 1 行ずつ、UTF-8 で読む
 *   （PowerShell 5.1 は標準入力を OEM コードページ（日本語環境では cp932）で解釈するため、そのままだと日本語のパスが化ける）
 * - 1 つ鳴らし終えるたびに、標準出力に played と書く
 * - 標準入力が閉じられたら終わる。WAV を読めないなど、失敗したときもそこで終わる
 */
const PLAY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false))
while ($null -ne ($file = $reader.ReadLine())) {
  $player = New-Object System.Media.SoundPlayer $file
  try {
    $player.Load()
    $player.PlaySync()
  } finally {
    $player.Dispose()
  }
  [Console]::Out.WriteLine('played')
  [Console]::Out.Flush()
}
`;

/** Windows: 起動したままの PowerShell 1 つで、順に鳴らす */
class PowerShellPlayer {
  #proc;
  #exited = false;
  #stopped = false;
  /** 鳴らしている WAV の play() の resolve。鳴らしていなければ null */
  #playing = null;

  /** 作った時点で PowerShell を起動しておく（最初の WAV ができるまでの間に、起動の時間を済ませるため） */
  constructor() {
    const encoded = Buffer.from(PLAY_SCRIPT, 'utf16le').toString('base64');
    this.#proc = spawn(WIN_POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let pending = '';
    this.#proc.stdout.setEncoding('utf8');
    this.#proc.stdout.on('data', (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (line.trim() === 'played') this.#settle(true);
      }
    });
    const onExit = () => {
      this.#exited = true;
      this.#settle(false);
    };
    this.#proc.on('error', onExit);
    this.#proc.on('close', onExit);
    this.#proc.stdin.on('error', () => {}); // PowerShell が先に終了した場合の EPIPE を無視する
  }

  play(file) {
    if (this.#stopped || this.#exited) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.#playing = resolve;
      this.#proc.stdin.write(`${file}\n`, 'utf8');
    });
  }

  stop() {
    this.#stopped = true;
    if (isRunning(this.#proc)) this.#proc.kill();
  }

  close() {
    this.#proc.stdin.end();
  }

  #settle(played) {
    const resolve = this.#playing;
    this.#playing = null;
    resolve?.(played);
  }
}

/** Mac: WAV ごとに afplay で鳴らす */
class AfplayPlayer {
  #proc = null;
  #stopped = false;

  play(file) {
    if (this.#stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.#proc = spawn('afplay', [file], { stdio: 'ignore' });
      this.#proc.on('error', () => resolve(false));
      this.#proc.on('close', (code) => resolve(code === 0));
    });
  }

  stop() {
    this.#stopped = true;
    if (isRunning(this.#proc)) this.#proc.kill('SIGKILL');
  }

  close() {
    // WAV ごとに起動して、鳴らし終えると終わるので、終わらせるものはない
  }
}

/** OS に合う鳴らし方を返す。対応していない OS では null */
function createWavPlayer(platform = process.platform) {
  switch (platform) {
    case 'win32':
      return new PowerShellPlayer();
    case 'darwin':
      return new AfplayPlayer();
    default:
      return null;
  }
}

module.exports = { createWavPlayer };
