/**
 * 排他制御（mkdir ロック + 持ち主の生存の合図 + セッション番号による差し替え）
 *
 * ほかのプロセスを止めることはしない。止めるのは、いつも声を出している本人（自分の子プロセス）だけ。
 * 持ち主がいるかどうかは PID ではなく、持ち主が書き直し続ける合図（state の beatAt）で見分ける。
 * OS や声に依存しない（Node の標準モジュールだけ）。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

/** ロックを待っている間に、空いたかを確かめ直す間隔（同じタブも別のタブも同じ） */
const POLL_INTERVAL_MS = 150;
/** 読んでいる間に、同じタブの新しい要求が来たかを確かめる間隔 */
const WATCH_INTERVAL_MS = 100;
/** 持ち主が、生存の合図（state の beatAt）を書き直す間隔 */
const HEARTBEAT_INTERVAL_MS = 500;
/** 合図がこれより古ければ、持ち主はいないとみなす */
const STALE_AFTER_MS = 3000;
/** state がない（または読めない形の）ロックを、持ち主がいないとみなすまでの猶予。mkdir から state を書くまでの間を守る */
const NO_STATE_GRACE_MS = 5000;
/** 同じタブの持ち主が、合図を書いているのにロックを返さないとき、待つのをあきらめるまでの時間 */
const SAME_TAB_GIVE_UP_MS = 5000;
/** これより長く更新されていない、タブごとの一時ファイルは片付ける */
const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 片付けの対象: latest-<タブ>、その書きかけ（latest-<タブ>.<PID>）、state の書きかけ（state.tmp.<PID>）。lock と state は対象外 */
const TEMP_FILE_PATTERN = /^(?:latest-[0-9a-f]{16}(?:\.\d+)?|state\.tmp\.\d+)$/;

/** #readState() の結果 */
const ABSENT = Object.freeze({ kind: 'absent' }); // state がない、または読めない形（書く前、古い版の形式など）
const UNREADABLE = Object.freeze({ kind: 'unreadable' }); // 一時的に読めない（書き換えと重なったときなど）。判断を次に回す

function removeQuietly(remove, target) {
  try {
    remove(target);
  } catch {
    // 既に無い場合などは無視する
  }
}

/**
 * mkdir ロックによる排他制御
 *
 * 持ち主（ロックを取った読み上げ）:
 *   ロックを持っている間、state に { requestId, session, beatAt } を書き、HEARTBEAT_INTERVAL_MS ごとに beatAt を書き直す。
 *   書き直す前に、state がまだ自分のものかを確かめる。自分のものでなければ（合図が途切れた間に片付けられ、
 *   ほかのタブに取られた場合など）、ロックを失ったとして自分の声を止めて終わる。
 *
 * 同じセッション（同じタブ）:
 *   新しい要求は latest-<タブ> に自分の番号を書き、ロックが空くのを待つ。前の読み上げのプロセスは止めない。
 *   読んでいる本人が startWatching() で latest-<タブ> を見張り、自分の番号でなくなったら自分の声を止めてロックを返す。
 *   待っている間に同じタブから新しい返事が来たら、読まずに終了する。
 *   持ち主が合図を書いているのに SAME_TAB_GIVE_UP_MS たってもロックを返さないときは、読まずに終了する（相手は止めない）。
 *
 * 別セッション（別タブ）:
 *   ロックが解放されるまで順番待ちする。
 *
 * 持ち主のいないロック:
 *   合図が STALE_AFTER_MS より古いとき（state がないときは、ロックのフォルダができてから NO_STATE_GRACE_MS たったとき）、
 *   持ち主がいないとみなして片付ける。消す直前に読み直し、判定に使ったときと同じときだけ消す（#removeIfUnchanged）。
 */
class SpeechQueue {
  static MAX_RETRIES = 10;

  #sessionId;
  #workDir;
  #lockDir;
  #stateFile;
  #stateTmp;
  #locked = false;
  #requestId = crypto.randomUUID();
  #latestPath;
  #retries = 0;
  #watchTimer = null;

  /**
   * @param {string} sessionId セッション番号（同じタブかどうかの判定に使う）
   * @param {string} workDir   ロックと状態のファイルを置くフォルダ
   */
  constructor(sessionId, workDir) {
    this.#sessionId = sessionId;
    this.#workDir = workDir;
    this.#lockDir = path.join(workDir, 'lock');
    this.#stateFile = path.join(workDir, 'state');
    this.#stateTmp = `${this.#stateFile}.tmp.${process.pid}`;
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    this.#latestPath = path.join(workDir, `latest-${sessionHash}`);
  }

  /**
   * ロックを取得する。次のときは false を返す。
   *   - 同じタブの新しい返事に追い越された
   *   - 同じタブの持ち主が、合図を書いているのに SAME_TAB_GIVE_UP_MS たってもロックを返さなかった
   *   - ロックの片付けや state の書き込みの試し直しが MAX_RETRIES 回を超えた
   */
  async acquire() {
    fs.mkdirSync(this.#workDir, { recursive: true });
    this.#registerRequest();
    let sameTabSince = null;
    while (this.#isLatestRequest()) {
      try {
        fs.mkdirSync(this.#lockDir);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const snapshot = this.#inspectLock();
        if (snapshot === null) continue; // 調べる前に返された。すぐ取り直す
        // 状態を読んだあとに確かめ直す。同じタブの新しい返事がもうロックを取っていたら、それを待たずに終わる
        if (!this.#isLatestRequest()) return false;
        if (this.#isStale(snapshot)) {
          if (!this.#countRetry()) return false;
          this.#removeIfUnchanged(snapshot);
        } else if (snapshot.read.kind === 'present' && snapshot.read.state.session === this.#sessionId) {
          // 同じタブ: 読んでいる本人が新しい要求に気づいて自分の声を止め、ロックを返すのを待つ
          sameTabSince ??= Date.now();
          if (Date.now() - sameTabSince > SAME_TAB_GIVE_UP_MS) return false;
        } else {
          sameTabSince = null;
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      // 取ったらすぐに state（最初の合図）を書く。書けなければロックを返して試し直す
      if (!this.#writeState()) {
        removeQuietly(fs.rmdirSync, this.#lockDir);
        if (!this.#countRetry()) return false;
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      this.#locked = true;
      // ロックを取ったあとにも確かめ直す。同じタブの新しい返事が来ていたら、ロックを譲って終わる
      if (!this.#isLatestRequest()) {
        this.release();
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * 読んでいる間の見張りと、生存の合図の書き直しを始める。次のときに onStop(reason) を1回だけ呼ぶ。
   *   'replaced'  同じタブの新しい要求が来た
   *   'lost'      ロックを失った（合図が途切れた間に片付けられた。ロックには触らずに終わる）
   * 呼ばれた側は自分の声を止める（声が止まれば読み上げが終わり、release() でロックが返る）。
   */
  startWatching(onStop) {
    this.stopWatching();
    let lastBeat = Date.now();
    const stop = (reason) => {
      this.stopWatching();
      if (reason === 'lost') this.#locked = false;
      onStop(reason);
    };
    this.#watchTimer = setInterval(() => {
      if (!this.#isLatestRequest()) return stop('replaced');
      const now = Date.now();
      if (now - lastBeat < HEARTBEAT_INTERVAL_MS) return;
      const owns = this.#ownsLock();
      if (owns === false) return stop('lost');
      // 一時的に読めない、または書けないときは、次の回に書き直す（STALE_AFTER_MS までに何度か試せる）
      if (owns === true && this.#writeState()) lastBeat = now;
    }, WATCH_INTERVAL_MS);
  }

  stopWatching() {
    if (this.#watchTimer === null) return;
    clearInterval(this.#watchTimer);
    this.#watchTimer = null;
  }

  /**
   * ロックを返す。state が自分のものでないと分かったとき（ほかのタブに取られたとき）は、相手のロックに触らない。
   * 一時的に読めないときは、自分のものとして返す（返さずにいると、ほかのタブが STALE_AFTER_MS 待たされるため）。
   */
  release() {
    this.stopWatching();
    if (!this.#locked) return;
    this.#locked = false;
    removeQuietly(fs.rmSync, this.#stateTmp);
    if (this.#ownsLock() === false) return;
    removeQuietly(fs.rmSync, this.#stateFile);
    removeQuietly(fs.rmdirSync, this.#lockDir);
  }

  /**
   * タブごとの一時ファイルを片付ける。読み上げの最後（読まずに終わるときも）に呼ぶ。
   *   - 自分の latest-<タブ>: まだ自分の番号なら消す（同じタブの新しい要求が書いていれば残す）
   *   - 古い一時ファイル: TEMP_MAX_AGE_MS より長く更新されていないものを消す（落ちたプロセスが残したものなど）
   * latest-<タブ> がないときは「自分が最新」として扱うので、使っているタブのものを消しても動きは壊れない。
   */
  cleanupTempFiles() {
    try {
      if (fs.readFileSync(this.#latestPath, 'utf8').trim() === this.#requestId) fs.rmSync(this.#latestPath, { force: true });
    } catch {
      // ない、または読めないときは何もしない
    }
    let names;
    try {
      names = fs.readdirSync(this.#workDir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      if (!TEMP_FILE_PATTERN.test(name)) continue;
      const file = path.join(this.#workDir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > TEMP_MAX_AGE_MS) fs.rmSync(file, { force: true });
      } catch {
        // 消されたばかりなどは無視する
      }
    }
  }

  /** 試し直しを1回数える。MAX_RETRIES 回を超えたら false を返す（延々と続けないため）。 */
  #countRetry() {
    this.#retries += 1;
    return this.#retries <= SpeechQueue.MAX_RETRIES;
  }

  #registerRequest() {
    const tmp = `${this.#latestPath}.${process.pid}`;
    fs.writeFileSync(tmp, this.#requestId);
    fs.renameSync(tmp, this.#latestPath);
  }

  #isLatestRequest() {
    try {
      return fs.readFileSync(this.#latestPath, 'utf8').trim() === this.#requestId;
    } catch {
      return true;
    }
  }

  /** state（合図）を書く。一時ファイルに書いてから置き換えるので、途中の状態は読まれない。書けたら true。 */
  #writeState() {
    try {
      fs.writeFileSync(this.#stateTmp, JSON.stringify({ requestId: this.#requestId, session: this.#sessionId, beatAt: Date.now() }));
      fs.renameSync(this.#stateTmp, this.#stateFile);
      return true;
    } catch {
      removeQuietly(fs.rmSync, this.#stateTmp);
      return false;
    }
  }

  /**
   * state を読む。
   *   { kind: 'present', state }  持ち主の { requestId, session, beatAt }
   *   ABSENT                      ない、または読めない形
   *   UNREADABLE                  一時的に読めない
   */
  #readState() {
    let text;
    try {
      text = fs.readFileSync(this.#stateFile, 'utf8');
    } catch (err) {
      return err.code === 'ENOENT' ? ABSENT : UNREADABLE;
    }
    try {
      const state = JSON.parse(text);
      if (state && typeof state.requestId === 'string' && typeof state.session === 'string' && Number.isFinite(state.beatAt)) {
        return { kind: 'present', state };
      }
    } catch {
      // 読めない形（古い版の「PID:セッション」形式など）は、ないものとして扱う
    }
    return ABSENT;
  }

  /** state が自分のものか。true: 自分のもの / false: ない、またはほかの要求のもの / null: 一時的に読めない */
  #ownsLock() {
    const read = this.#readState();
    if (read.kind === 'unreadable') return null;
    return read.kind === 'present' && read.state.requestId === this.#requestId;
  }

  /**
   * 今のロックの様子を読む。ロックがなければ null。
   *   dirId    ロックのフォルダの身元（作り直されたかを見分ける。state がないときの判定に使う）
   *   ctimeMs  ロックのフォルダができた時刻（state がないときの猶予に使う）
   *   read     #readState() の結果
   * フォルダを一時的に調べられないときは、read を UNREADABLE にして、判断を次の確認に回す。
   */
  #inspectLock() {
    let stat;
    try {
      stat = fs.statSync(this.#lockDir, { bigint: true });
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      return { dirId: null, ctimeMs: Date.now(), read: UNREADABLE };
    }
    return { dirId: `${stat.ino}:${stat.birthtimeNs}`, ctimeMs: Number(stat.ctimeMs), read: this.#readState() };
  }

  /** 持ち主がいないロックか。一時的に state を読めないときは、判断を次の確認に回す（false）。 */
  #isStale(snapshot) {
    const now = Date.now();
    switch (snapshot.read.kind) {
      case 'present':
        return now - snapshot.read.state.beatAt > STALE_AFTER_MS;
      case 'absent':
        return now - snapshot.ctimeMs > NO_STATE_GRACE_MS;
      default:
        return false;
    }
  }

  /**
   * 持ち主がいないと判定したロックを片付ける。消す直前に読み直し、判定に使ったときと同じときだけ消す。
   *   合図が古かった（state があった）:
   *     読み直した state が、同じ要求の同じ合図のときだけ消す。state がなくなっていたら消さない
   *     （別のタブが片付けて取り直した直後で、まだ state を書いていない場合があるため）
   *   state がないまま猶予が切れた:
   *     まだ state がなく、ロックのフォルダが作り直されていない（身元が同じ）ときだけ消す
   *     （state がないことだけで「違う持ち主」とすると、state を書く前に落ちた持ち主のロックがいつまでも残るため）
   */
  #removeIfUnchanged(snapshot) {
    const current = this.#inspectLock();
    if (current === null) return;
    if (snapshot.read.kind === 'present') {
      if (current.read.kind !== 'present') return;
      const judged = snapshot.read.state;
      const now = current.read.state;
      if (now.requestId !== judged.requestId || now.beatAt !== judged.beatAt) return;
    } else if (current.read.kind !== 'absent' || current.dirId !== snapshot.dirId) {
      return;
    }
    removeQuietly(fs.rmSync, this.#stateFile);
    removeQuietly(fs.rmdirSync, this.#lockDir);
  }
}

module.exports = { SpeechQueue };
