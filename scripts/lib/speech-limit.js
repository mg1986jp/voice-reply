/**
 * 読み上げを止めるときの時間の決まり（OS や声に依存しない）
 *
 *   STOP_GRACE_MS  声を止めてから、読み上げが終わるのを待つ上限
 */
'use strict';

/**
 * 声を止めてから、読み上げ（声の子プロセス）が終わるのを待つ上限。
 * ふつうは止めるとすぐに終わる（Mac は SIGKILL、Windows は TerminateProcess で強制的に終わらせる）。
 * それでも終わらないときは、待つのをやめて、ロックを返して終わる（ほかのタブを待たせ続けないため）。
 */
const STOP_GRACE_MS = 2000;

module.exports = { STOP_GRACE_MS };
