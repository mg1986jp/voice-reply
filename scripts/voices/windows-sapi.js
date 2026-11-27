/**
 * 声: Windows の SAPI の声（Windows PowerShell 5.1 の System.Speech で読む）
 *
 * 設定（環境変数）:
 *   CLAUDE_SAY_VOICE     声の名前（初期値: Microsoft Haruka Desktop）
 *                        指定した声が入っていなければ、日本語の声に切り替える
 *   CLAUDE_SAY_WIN_RATE  速さ（System.Speech の Rate。-10〜10 の整数、初期値 3 ≒ 標準の約1.4倍）
 */
'use strict';

const { spawn } = require('node:child_process');
const { WIN_POWERSHELL } = require('../lib/windows');

const DEFAULT_VOICE = 'Microsoft Haruka Desktop';
const DEFAULT_RATE = 3; // System.Speech の Rate（0 が標準の速さ。3 で約1.4倍）
const RATE_MIN = -10;
const RATE_MAX = 10;

/** System.Speech の Rate に渡す速さ。-10〜10 の整数でなければ初期値を使う。 */
function parseRate(value) {
  const rate = Number.parseInt(value ?? '', 10);
  return Number.isInteger(rate) && rate >= RATE_MIN && rate <= RATE_MAX ? rate : DEFAULT_RATE;
}

/**
 * Windows PowerShell 5.1 に -EncodedCommand で渡す読み上げスクリプト
 *
 * - 文章は標準入力から UTF-8 のバイト列として読む
 *   （PowerShell 5.1 は標準入力を OEM コードページ（日本語環境では cp932）で解釈するため、そのままだと化ける）
 * - 声と速さは環境変数で受け取る（コマンドラインに埋め込むと引用符の扱いが必要になるため）
 * - 声は「指定した声 → 日本語の女性の声 → 日本語の声」の順に、入っているものを選ぶ
 * - Speak() は合成しながら再生し、読み終わるまで戻らない
 */
const SPEAK_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Speech
$buffer = New-Object System.IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($buffer)
$text = [System.Text.Encoding]::UTF8.GetString($buffer.ToArray())
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })
  $japanese = @($voices | Where-Object { $_.Culture.Name -eq 'ja-JP' })
  $candidates = @($voices | Where-Object { $_.Name -eq $env:CLAUDE_SAY_SAPI_VOICE }) + @($japanese | Where-Object { $_.Gender -eq 'Female' }) + $japanese
  if ($candidates.Count -gt 0) { $synth.SelectVoice($candidates[0].Name) }
  $synth.Rate = [int]$env:CLAUDE_SAY_SAPI_RATE
  $synth.SetOutputToDefaultAudioDevice()
  $synth.Speak($text)
} finally {
  $synth.Dispose()
}
`;

/** Windows の System.Speech（SAPI の声）で読み上げる */
class WindowsSapi {
  #voice;
  #rate;
  #proc = null;

  constructor(voice, rate) {
    this.#voice = voice;
    this.#rate = rate;
  }

  speak(text) {
    return new Promise((resolve) => {
      const encoded = Buffer.from(SPEAK_SCRIPT, 'utf16le').toString('base64');
      this.#proc = spawn(WIN_POWERSHELL, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        stdio: ['pipe', 'inherit', 'inherit'],
        windowsHide: true,
        env: { ...process.env, CLAUDE_SAY_SAPI_VOICE: this.#voice, CLAUDE_SAY_SAPI_RATE: String(this.#rate) },
      });
      this.#proc.on('error', () => resolve());
      this.#proc.on('close', () => resolve());
      this.#proc.stdin.on('error', () => {}); // PowerShell が先に終了した場合の EPIPE を無視する
      this.#proc.stdin.end(text, 'utf8');
    });
  }

  kill() {
    // 読み上げは PowerShell のプロセスの中で行うため、プロセスを終わらせれば声も止まる
    if (this.#proc && this.#proc.exitCode === null && this.#proc.signalCode === null) {
      this.#proc.kill();
    }
  }
}

/** 環境変数の設定から作る */
function create(env) {
  return new WindowsSapi(env.CLAUDE_SAY_VOICE || DEFAULT_VOICE, parseRate(env.CLAUDE_SAY_WIN_RATE));
}

module.exports = { create };
