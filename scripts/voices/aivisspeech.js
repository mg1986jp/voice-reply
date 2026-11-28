/**
 * 声: AivisSpeech Engine（利用者が起動しておいたエンジンの HTTP API で音声を作り、WAV を鳴らす）
 *
 * 設定（環境変数）:
 *   VOICE_REPLY_AIVIS_STYLE  スタイル ID（整数、初期値: 888753760 = まお／ノーマル）。
 *                            エンジンに入っていなければ、入っている声の最初のスタイルを使う
 *   VOICE_REPLY_AIVIS_SPEED  話す速さ（speedScale。0.5〜2.0、初期値 1.4）
 *   VOICE_REPLY_AIVIS_URL    エンジンの URL（初期値: http://127.0.0.1:10101）
 *
 * 読み方:
 *   文に分け（lib/sentences.js）、1 文ずつ audio_query → synthesis で WAV を作り、一時ファイルに書いて鳴らす（lib/wav-player.js）。
 *   1 文を鳴らしている間に、次の 1 文を作る。鳴らし終えた WAV はすぐに消す。
 *   文ごとに、その文に取りかかる前に onSegment(文, この声) を呼ぶ（speak.js が、文ごとに時間の上限を測り直す）。
 *   1 文目の区切りは、声の一覧の問い合わせから 1 文目を鳴らし終えるまで。2 文目からは、前の文を鳴らし終えてから、その文を鳴らし終えるまで。
 *
 * speak() の結果（SpeakOutcome）:
 *   FINISHED             最後まで読んだ
 *   STOPPED              kill() で止められた
 *   FAILED_BEFORE_START  1 文目の音を鳴らし始める前に失敗した（まだ何も聞こえていない）。voices/index.js が OS の声で読み直す。
 *                        「鳴らし始めた」は、音を出す処理が実際に始まったこと（lib/wav-player.js の started）。
 *                        エンジンの失敗のほか、afplay を起動できない、Windows で WAV を読み込めない・WAV の形でない、も含む
 *   FAILED               音を鳴らし始めたあとに失敗した（1 文目を鳴らしている途中、2 文目から）。そこでやめる
 *                        （次の文を作るのに失敗したときは、鳴っていた文を最後まで鳴らしてからやめる）
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { splitSentences } = require('../lib/sentences');
const { createWavPlayer } = require('../lib/wav-player');
const { getDataDir, getAudioDir } = require('../lib/paths');

const DEFAULT_URL = 'http://127.0.0.1:10101';
const DEFAULT_STYLE_ID = 888753760; // まお／ノーマル（エンジンの初期のモデル）
const DEFAULT_SPEED = 1.4;
/** エンジンが受け付ける speedScale の範囲（AivisSpeech Engine 1.2.0 の API の説明） */
const SPEED_MIN = 0.5;
const SPEED_MAX = 2.0;

/**
 * エンジンが動いているかを確かめる問い合わせ（/version）を待つ上限。
 * 動いているエンジンは数ミリ秒で応答し、動いていなければ（ポートが閉じていれば）すぐに失敗する。
 * 応答が遅いのは、エンジンが起動の途中のときなど。待たずに OS の声で読む。
 */
const PROBE_TIMEOUT_MS = 1500;

/**
 * speedScale と、1 秒に読む文字数の対応（まお／ノーマルで、本物の返事の要約 402 文字を測った値）。
 * speedScale と速さは比例しない（無音など、速さによらない部分があるため）。
 */
const MEASURED_SPEEDS = [
  [0.8, 5.0],
  [1.0, 6.09],
  [1.2, 7.08],
  [1.5, 8.5],
];

/** 一時ファイルの WAV の名前 */
const AUDIO_FILE_PATTERN = /^[0-9a-f-]{36}\.wav$/;
/**
 * これより長く残っている WAV は片付ける（強制終了などで消せなかったもの）。
 * WAV は 1 文ぶんで、鳴らし終えたらすぐに消すので、使っている途中の WAV がこれほど長く残ることはない。
 */
const AUDIO_MAX_AGE_MS = 60 * 60 * 1000;

const SpeakOutcome = Object.freeze({
  FINISHED: 'finished',
  STOPPED: 'stopped',
  FAILED_BEFORE_START: 'failed-before-start',
  FAILED: 'failed',
});

/** スタイル ID。整数でなければ初期値を使う（ID は負の数のこともある） */
function parseStyleId(value) {
  const text = (value ?? '').trim();
  const id = Number(text);
  return /^-?\d+$/.test(text) && Number.isSafeInteger(id) ? id : DEFAULT_STYLE_ID;
}

/** speedScale。SPEED_MIN〜SPEED_MAX の数でなければ初期値を使う（設定がないときは NaN になり、初期値を使う） */
function parseSpeed(value) {
  const speed = Number.parseFloat(value);
  return Number.isFinite(speed) && speed >= SPEED_MIN && speed <= SPEED_MAX ? speed : DEFAULT_SPEED;
}

/** エンジンの URL（末尾の / を除く）。http か https の URL でなければ初期値を使う（設定がないときは URL として読めず、初期値を使う） */
function parseUrl(value) {
  try {
    const { protocol } = new URL(value);
    if (protocol === 'http:' || protocol === 'https:') return value.replace(/\/+$/, '');
  } catch {
    // URL として読めないときは初期値を使う
  }
  return DEFAULT_URL;
}

/**
 * speedScale から、1 秒に読む文字数を見積もる。測った値の間は直線でつなぐ。
 * 測った範囲の外は、上限が短くなる向き（実際より速い見積もり）にずれないようにする:
 *   遅い側（0.8 より下）: 0.8 の値から speedScale に比例して下げる。実際は比例するほど遅くならない（速さによらない無音などがあるため）ので、
 *                         見積もりは実際より遅くなり、上限は長くなる向きにずれる
 *   速い側（1.5 より上）: 1.5 の値で頭打ちにする。実際はそれより速いので、上限は長くなる向きにずれる
 * 測った値の間も、速さが上がるほど伸びが鈍る形なので、直線でつなぐと実際より少し遅めの見積もりになる。
 */
function estimateCharsPerSecond(speed) {
  const [slowestSpeed, slowestRate] = MEASURED_SPEEDS[0];
  const [fastestSpeed, fastestRate] = MEASURED_SPEEDS[MEASURED_SPEEDS.length - 1];
  if (speed <= slowestSpeed) return (slowestRate * speed) / slowestSpeed;
  if (speed >= fastestSpeed) return fastestRate;
  const upper = MEASURED_SPEEDS.findIndex(([measured]) => measured >= speed);
  const [lowSpeed, lowRate] = MEASURED_SPEEDS[upper - 1];
  const [highSpeed, highRate] = MEASURED_SPEEDS[upper];
  return lowRate + ((highRate - lowRate) * (speed - lowSpeed)) / (highSpeed - lowSpeed);
}

/** ファイルを消す。既に無い場合などは無視する */
function removeFile(file) {
  if (file === undefined) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 鳴らしている途中で消せないときなどは、あとで AUDIO_MAX_AGE_MS を過ぎてから片付ける
  }
}

/**
 * HTTP の要求を送る。応答が 2xx でなければ例外を投げる。
 * 失敗の応答の本文は読まない（speak() の終わりに AbortController で要求ごと取りやめるので、接続は残らない）
 */
async function request(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`AivisSpeech Engine responded ${response.status}`);
  return response;
}

/** AivisSpeech Engine で読み上げる */
class AivisSpeech {
  #baseUrl;
  #styleId;
  #speed;
  #audioDir;
  #abort = null;
  #player = null;
  #killed = false;

  constructor({ baseUrl, styleId, speed, audioDir }) {
    this.#baseUrl = baseUrl;
    this.#styleId = styleId;
    this.#speed = speed;
    this.#audioDir = audioDir;
  }

  /** エンジンが PROBE_TIMEOUT_MS のうちに応答するか（voices/index.js が、どの声で読むかを決めるのに使う） */
  async isAvailable() {
    try {
      const response = await fetch(`${this.#baseUrl}/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      await response.arrayBuffer();
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 文ごとに作って、順に鳴らす。どんなときも reject せず、SpeakOutcome のどれかで resolve する
   * @param {string} text                                     読む文章
   * @param {{ onSegment?: (segment: string, voice: AivisSpeech) => void }} options
   */
  async speak(text, { onSegment = () => {} } = {}) {
    const sentences = splitSentences(text);
    if (sentences.length === 0) return SpeakOutcome.FINISHED;
    const abort = new AbortController();
    const player = createWavPlayer();
    this.#abort = abort;
    this.#player = player;
    if (this.#killed) this.kill(); // 読み始める前に止められていた
    this.#removeStaleAudio();

    let next = null; // 作っている途中の、次の文（#prepare() の Promise）
    let startedPlaying = false; // 音を鳴らし始めたか（一度鳴らし始めたら、あとの文で失敗しても true のまま）
    const failed = () => (startedPlaying ? SpeakOutcome.FAILED : SpeakOutcome.FAILED_BEFORE_START);
    try {
      onSegment(sentences[0], this);
      const styleId = await this.#resolveStyle(abort.signal);
      next = this.#prepare(sentences[0], styleId, abort.signal);
      for (let i = 0; i < sentences.length; i++) {
        if (i > 0) onSegment(sentences[i], this);
        const prepared = await next;
        next = null;
        if (this.#killed) {
          removeFile(prepared.file);
          return SpeakOutcome.STOPPED;
        }
        if (prepared.error) return failed();
        // この文を鳴らしている間に、次の文を作る
        if (i + 1 < sentences.length) next = this.#prepare(sentences[i + 1], styleId, abort.signal);
        const { played, started } = await player.play(prepared.file);
        startedPlaying ||= started;
        removeFile(prepared.file);
        if (this.#killed) return SpeakOutcome.STOPPED;
        if (!played) return failed();
      }
    } catch {
      // 声の一覧を取れなかったときなど
      return this.#killed ? SpeakOutcome.STOPPED : failed();
    } finally {
      abort.abort();
      player.close();
      // 作りかけの文は、取りやめたあとに終わるのを待ってから、できていた WAV を消す（#prepare() は reject しない）
      if (next !== null) removeFile((await next).file);
    }
    return SpeakOutcome.FINISHED;
  }

  /** 読み上げを即座に止める（鳴らしている子プロセスを止め、作りかけの文の HTTP の要求を取りやめる） */
  kill() {
    this.#killed = true;
    this.#abort?.abort();
    this.#player?.stop();
  }

  /** 1 秒に読む文字数（speedScale から見積もる）。まお／ノーマルで測った値なので、ほかの声では実際の速さとずれることがある */
  charsPerSecond() {
    return estimateCharsPerSecond(this.#speed);
  }

  /** 使うスタイル ID を決める。設定のスタイルがエンジンに入っていなければ、入っている声の最初のスタイル（読み上げ用のもの） */
  async #resolveStyle(signal) {
    const speakers = await (await request(`${this.#baseUrl}/speakers`, { signal })).json();
    const styles = (Array.isArray(speakers) ? speakers : [])
      .flatMap((speaker) => (Array.isArray(speaker?.styles) ? speaker.styles : []))
      .filter((style) => Number.isSafeInteger(style?.id) && (style.type ?? 'talk') === 'talk');
    if (styles.some((style) => style.id === this.#styleId)) return this.#styleId;
    if (styles.length === 0) throw new Error('AivisSpeech Engine has no voices');
    return styles[0].id;
  }

  /**
   * 1 文の WAV を作り、一時ファイルに書く。reject せず、{ file } か { error } で resolve する
   * （次の文は、前の文を鳴らしている間に作る。失敗が鳴らし終える前に起きても、未処理の reject にしないため）
   */
  async #prepare(sentence, styleId, signal) {
    try {
      const queryUrl = `${this.#baseUrl}/audio_query?speaker=${styleId}&text=${encodeURIComponent(sentence)}`;
      const query = await (await request(queryUrl, { method: 'POST', signal })).json();
      query.speedScale = this.#speed;
      const synthesis = await request(`${this.#baseUrl}/synthesis?speaker=${styleId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query),
        signal,
      });
      const wav = Buffer.from(await synthesis.arrayBuffer());
      fs.mkdirSync(this.#audioDir, { recursive: true });
      const file = path.join(this.#audioDir, `${crypto.randomUUID()}.wav`);
      fs.writeFileSync(file, wav);
      return { file };
    } catch (error) {
      return { error };
    }
  }

  /** 強制終了などで消せずに残った、古い WAV を片付ける */
  #removeStaleAudio() {
    let names;
    try {
      names = fs.readdirSync(this.#audioDir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names.filter((entry) => AUDIO_FILE_PATTERN.test(entry))) {
      const file = path.join(this.#audioDir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > AUDIO_MAX_AGE_MS) fs.rmSync(file, { force: true });
      } catch {
        // 消されたばかりなどは無視する
      }
    }
  }
}

/** 環境変数の設定から作る */
function create(env) {
  const dataDir = getDataDir(env);
  return new AivisSpeech({
    baseUrl: parseUrl(env.VOICE_REPLY_AIVIS_URL),
    styleId: parseStyleId(env.VOICE_REPLY_AIVIS_STYLE),
    speed: parseSpeed(env.VOICE_REPLY_AIVIS_SPEED),
    audioDir: dataDir ? getAudioDir(dataDir) : path.join(os.tmpdir(), 'voice-reply-audio'),
  });
}

module.exports = { create, SpeakOutcome };
