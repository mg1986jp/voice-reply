/**
 * 排他制御（mkdir ロック + セッション番号による差し替え）
 *
 * ほかのプロセスを止めることはしない。止めるのは、いつも声を出している本人（自分の子プロセス）だけ。
 * OS や声に依存しない。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const STALE_CHECK_INTERVAL_MS = 2000;
/** 同じタブの持ち主がロックを返すのを待つ間に、確かめ直す間隔 */
const SAME_TAB_POLL_MS = 100;
/** 読んでいる間に、同じタブの新しい要求が来たかを確かめる間隔 */
const WATCH_INTERVAL_MS = 100;
/** 同じタブの持ち主が、生きているのにロックを返さないとき、待つのをあきらめるまでの時間 */
const SAME_TAB_GIVE_UP_MS = 5000;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM は「プロセスはいるが権限がない」なので生きている扱い
    return err.code !== 'ESRCH';
  }
}

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
 * 同じセッション（同じタブ）:
 *   新しい要求は latest-<タブ> に自分の番号を書き、ロックが空くのを待つ。前の読み上げのプロセスは止めない。
 *   読んでいる本人が startWatching() で latest-<タブ> を見張り、自分の番号でなくなったら自分の声を止めてロックを返す。
 *   待っている間に同じタブから新しい返事が来たら、読まずに終了する。
 *   持ち主が生きているのに SAME_TAB_GIVE_UP_MS たってもロックを返さないときは、読まずに終了する（相手は止めない）。
 *
 * 別セッション（別タブ）:
 *   ロックが解放されるまで順番待ちする。
 */
class SpeechQueue {
  static MAX_RETRIES = 10;

  #sessionId;
  #workDir;
  #lockDir;
  #stateFile;
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
    const sessionHash = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    this.#latestPath = path.join(workDir, `latest-${sessionHash}`);
  }

  /**
   * ロックを取得する。次のときは false を返す。
   *   - 同じタブの新しい返事に追い越された
   *   - 同じタブの持ち主が、生きているのに SAME_TAB_GIVE_UP_MS たってもロックを返さなかった
   *   - 持ち主のいないロックの片付けが MAX_RETRIES 回を超えた
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
        const { pid, session } = this.#readState();
        // 状態を読んだあとに確かめ直す。同じタブの新しい返事がもうロックを取っていたら、それを待たずに終わる
        if (!this.#isLatestRequest()) return false;
        if (this.#isStale(pid)) {
          if (!this.#countRetry()) return false;
          this.#cleanupLock();
          await sleep(100);
        } else if (session === this.#sessionId) {
          // 同じタブ: 読んでいる本人が新しい要求に気づいて自分の声を止め、ロックを返すのを待つ
          sameTabSince ??= Date.now();
          if (Date.now() - sameTabSince > SAME_TAB_GIVE_UP_MS) return false;
          await sleep(SAME_TAB_POLL_MS);
        } else {
          sameTabSince = null;
          await sleep(STALE_CHECK_INTERVAL_MS);
        }
        continue;
      }
      this.#locked = true;
      // ロックを取ったあとにも確かめ直す。同じタブの新しい返事が来ていたら、ロックを譲って終わる
      if (!this.#isLatestRequest()) {
        this.release();
        return false;
      }
      this.#writeState();
      return true;
    }
    return false;
  }

  /**
   * 読んでいる間の見張りを始める。同じタブの新しい要求が来たら、onReplaced() を1回だけ呼ぶ。
   * 呼ばれた側は自分の声を止める（声が止まれば読み上げが終わり、release() でロックが返る）。
   */
  startWatching(onReplaced) {
    this.stopWatching();
    this.#watchTimer = setInterval(() => {
      if (this.#isLatestRequest()) return;
      this.stopWatching();
      onReplaced();
    }, WATCH_INTERVAL_MS);
  }

  stopWatching() {
    if (this.#watchTimer === null) return;
    clearInterval(this.#watchTimer);
    this.#watchTimer = null;
  }

  release() {
    this.stopWatching();
    if (!this.#locked) return;
    this.#cleanupLock();
    this.#locked = false;
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

  #writeState() {
    const tmp = `${this.#stateFile}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, `${process.pid}:${this.#sessionId}`);
    fs.renameSync(tmp, this.#stateFile);
  }

  /** { pid, session } を返す。読めない場合はどちらも null。 */
  #readState() {
    try {
      const content = fs.readFileSync(this.#stateFile, 'utf8').trim();
      const sep = content.indexOf(':');
      const pidStr = sep === -1 ? '' : content.slice(0, sep);
      // 0 や負の PID はプロセスグループ宛てになるため、壊れた state として扱う
      if (!/^\d+$/.test(pidStr) || Number(pidStr) === 0) return { pid: null, session: null };
      return { pid: Number(pidStr), session: content.slice(sep + 1) };
    } catch {
      return { pid: null, session: null };
    }
  }

  #isStale(pid) {
    if (pid === null) {
      // mkdir 直後で state がまだ書かれていない場合があるため、猶予を置く
      try {
        return Date.now() - fs.statSync(this.#lockDir).ctimeMs > 5000;
      } catch {
        return true;
      }
    }
    return !isProcessAlive(pid);
  }

  #cleanupLock() {
    removeQuietly(fs.rmSync, this.#stateFile);
    removeQuietly(fs.rmSync, `${this.#stateFile}.tmp.${process.pid}`);
    removeQuietly(fs.rmdirSync, this.#lockDir);
  }
}

module.exports = { SpeechQueue };
