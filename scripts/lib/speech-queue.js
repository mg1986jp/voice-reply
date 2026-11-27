/**
 * 排他制御（mkdir ロック + セッション番号による差し替え）
 *
 * OS や声に依存しない。前の読み上げの止め方だけ OS ごとに違う。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { WIN_TASKKILL, WIN_TASKLIST } = require('./windows');

const STALE_CHECK_INTERVAL_MS = 2000;

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

/** SpeechQueue.#stopPrevious() の結果 */
const StopResult = Object.freeze({
  STOPPED: 'stopped', // 止めた（または、もう終わっていた）
  NOT_OWNER: 'not-owner', // PID が読み上げのプロセスではなかった（使い回し）→ 持ち主のいないロックとして片付ける
  KILL_FAILED: 'kill-failed', // 止められなかった → ロックは残して試し直す
  QUERY_FAILED: 'query-failed', // 止めてよいかを確かめられなかった → ロックは残して読み上げをあきらめる
});

/**
 * mkdir ロックによる排他制御
 *
 * 同じセッション（同じタブ）:
 *   前の読み上げプロセスに SIGTERM を送って差し替える（Windows では taskkill で子プロセスごと止める）。
 *   待っている間に同じタブから新しい返事が来たら、読まずに終了する。
 *   Windows で前の読み上げを止めてよいか確かめられないとき、または止められないときは、ロックを残して読まずに終了する。
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
   *   - 前の読み上げを止めてよいか確かめられなかった、または止められなかった（ロックは残す）
   *   - 試し直しが MAX_RETRIES 回を超えた
   */
  async acquire() {
    fs.mkdirSync(this.#workDir, { recursive: true });
    this.#registerRequest();
    while (this.#isLatestRequest()) {
      try {
        fs.mkdirSync(this.#lockDir);
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const { pid, session } = this.#readState();
        // 状態を読んだあとに確かめ直す。同じタブの新しい返事がもうロックを取っていたら、それを止めずに終わる
        if (!this.#isLatestRequest()) return false;
        if (this.#isStale(pid)) {
          if (!this.#countRetry()) return false;
          this.#cleanupLock();
          await sleep(100);
        } else if (session === this.#sessionId) {
          const result = await SpeechQueue.#stopPrevious(pid);
          if (result === StopResult.QUERY_FAILED) return false; // 止めてよいか分からないので、ロックは残す
          if (result === StopResult.NOT_OWNER || result === StopResult.KILL_FAILED) {
            if (!this.#countRetry()) return false;
            // 持ち主でなければロックを片付ける。止められなかったときは、ロックを残したまま試し直す
            if (result === StopResult.NOT_OWNER) this.#cleanupLock();
            await sleep(100);
          }
        } else {
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

  release() {
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

  /**
   * 前の読み上げを止め、プロセスが終わるまで最大2秒待つ。結果は StopResult で返す。
   * 2秒待っても終わらなければ KILL_FAILED を返す。
   *
   * Windows では process.kill() が SIGTERM でも即座に終了させるため、前のプロセスの後片付け
   * （子の PowerShell を止める、ロックを解放する）が動かない。そこで taskkill で子プロセスごと止める。
   * 子プロセスごと止めるので、その前に PID が node.exe のものかを確かめ、違えば止めない。
   * 止めたあとに残ったロックは、acquire() の次のループで「持ち主のいないロック」として片付く。
   */
  static async #stopPrevious(pid) {
    if (process.platform === 'win32') {
      const isNode = await SpeechQueue.#isNodeProcessOnWindows(pid);
      if (isNode === null) return StopResult.QUERY_FAILED;
      if (!isNode) return StopResult.NOT_OWNER;
      // taskkill が失敗しても、その間に終わっていれば止める必要はない（ロックは次のループで片付く）
      if (!(await SpeechQueue.#killProcessTreeOnWindows(pid)) && isProcessAlive(pid)) return StopResult.KILL_FAILED;
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (err) {
        // ESRCH はもう終わっている。EPERM など止められなかったときは、試し直しの回数に数えさせる（MAX_RETRIES で打ち切る）
        return err.code === 'ESRCH' ? StopResult.STOPPED : StopResult.KILL_FAILED;
      }
    }
    for (let i = 0; i < 20; i++) {
      if (!isProcessAlive(pid)) return StopResult.STOPPED;
      await sleep(100);
    }
    // 2秒待っても終わらなければ止められなかったとみなし、試し直しの回数に数えさせる（MAX_RETRIES で打ち切る）
    return StopResult.KILL_FAILED;
  }

  /**
   * その PID のプロセスが node.exe かを tasklist で確かめる。
   *   true:  node.exe
   *   false: 別のプロセス、または、もういない
   *   null:  照会に失敗した（起動できない、終了コードが0以外、出力を読めない）
   */
  static #isNodeProcessOnWindows(pid) {
    return new Promise((resolve) => {
      const proc = spawn(WIN_TASKLIST, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let output = '';
      proc.stdout?.on('data', (chunk) => {
        output += chunk.toString('latin1'); // 見るのは ASCII のイメージ名と PID だけなので、文字コードは問わない
      });
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => {
        if (code !== 0) return resolve(null);
        // 例: "node.exe","1234","Console","1","45,678 K"
        const row = /^"([^"]*)","(\d+)"/m.exec(output);
        if (row) return resolve(Number(row[2]) === pid ? row[1].toLowerCase() === 'node.exe' : null);
        // 一覧に出ないとき、tasklist は案内の文（言語によって違う）だけを出す。
        // プロセスがもういなければ「別のプロセス」と同じ扱い。いるのに出てこないなら、出力を読めなかったとみなす
        return resolve(isProcessAlive(pid) ? null : false);
      });
    });
  }

  /** taskkill で子プロセスごと止める。終了コードが0のときだけ true（起動できない、0以外は false） */
  static #killProcessTreeOnWindows(pid) {
    return new Promise((resolve) => {
      const proc = spawn(WIN_TASKKILL, ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  }

  #cleanupLock() {
    removeQuietly(fs.rmSync, this.#stateFile);
    removeQuietly(fs.rmSync, `${this.#stateFile}.tmp.${process.pid}`);
    removeQuietly(fs.rmdirSync, this.#lockDir);
  }
}

module.exports = { SpeechQueue };
