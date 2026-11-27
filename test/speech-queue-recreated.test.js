/**
 * SpeechQueue のテスト: state のない古いロックが、消す直前に作り直されていた場合（5 秒以上待つので別のファイル）
 *   node --test test/*.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { SpeechQueue } = require('../scripts/lib/speech-queue');
const h = require('./helpers');

test('state のない古いロックは、消す直前にフォルダが作り直されていたら片付けない', async (t) => {
  const workDir = h.makeWorkDir(t);
  h.plantLock(workDir, null);
  let armed = false;
  let recreated = null;
  // 本物と同じ基準（フォルダの ctime から 5 秒を超えたか）で猶予切れを見分ける。猶予切れと判定される様子の次の確認が
  // 「消す直前の読み直し」なので、その直前に、ほかのタブが片付けて取り直したことにする
  const restore = h.hookLockStat(workDir, {
    before() {
      if (!armed || recreated !== null) return;
      fs.rmdirSync(h.lockDir(workDir));
      fs.mkdirSync(h.lockDir(workDir));
      recreated = h.lockIdentity(workDir);
    },
    after(_count, stat) {
      if (!armed && Date.now() - Number(stat.ctimeMs) > 5000) armed = true;
    },
  });
  t.after(restore);

  const queue = h.track(new SpeechQueue('tab-B', workDir).acquire());
  await h.waitFor(() => recreated !== null, 8000, '消す直前の読み直しまで進む');
  await h.sleep(500);
  restore();
  assert.equal(queue.settled, false);
  assert.equal(h.lockIdentity(workDir), recreated, '作り直されたロックを消してはいけない');

  fs.rmdirSync(h.lockDir(workDir)); // 取り直したタブが返したことにして、待っている要求を終わらせる
  assert.equal(await queue.promise, true);
});
