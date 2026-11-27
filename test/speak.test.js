/**
 * Stop フック（scripts/speak.js）を実際に起動するテスト。声は test/fixtures/fake-say.js の偽物を使う。
 *   node --test test/*.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers');

const SPEAK = path.join(__dirname, '..', 'scripts', 'speak.js');
const FAKE_SAY = path.join(__dirname, 'fixtures', 'fake-say.js');

/** データフォルダと、偽の声の印を書くフォルダを用意する */
function setup(t) {
  const root = h.makeWorkDir(t);
  const dataDir = path.join(root, 'data');
  const voiceDir = path.join(root, 'voice');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(voiceDir);
  return { dataDir, voiceDir, workDir: path.join(dataDir, 'tmp') };
}

/** speak.js を Stop フックとして起動する。終わったら終了コードで resolve する */
function runSpeak({ dataDir, voiceDir }, session, text, durationMs, extraEnv = {}) {
  const child = spawn(process.execPath, ['--require', FAKE_SAY, SPEAK], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir, FAKE_VOICE_DIR: voiceDir, FAKE_VOICE_MS: String(durationMs), ...extraEnv },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.stdin.end(JSON.stringify({ session_id: session, last_assistant_message: `本文です。<speak>${text}</speak>`, cwd: '' }));
  const exited = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  return { pid: child.pid, exited };
}

const marker = (voiceDir, pid, name) => path.join(voiceDir, `${pid}.${name}`);
const has = (voiceDir, pid, name) => fs.existsSync(marker(voiceDir, pid, name));

test('同じタブの新しい返事が来ると、前の読み上げは自分の声を止めて終わり、新しい返事が読まれる', async (t) => {
  const env = setup(t);
  const first = runSpeak(env, 'tab-A', '前の返事', 10000);
  await h.waitFor(() => has(env.voiceDir, first.pid, 'started'), 5000, '前の返事が読み始める');

  const second = runSpeak(env, 'tab-A', '新しい返事', 300);
  assert.equal(await first.exited, 0, '前の読み上げは止められたのではなく、自分で終わる');
  assert.equal(await second.exited, 0);

  assert.equal(has(env.voiceDir, first.pid, 'killed'), true, '前の声は途中で止まる');
  assert.equal(has(env.voiceDir, first.pid, 'done'), false);
  assert.equal(fs.readFileSync(marker(env.voiceDir, second.pid, 'started'), 'utf8'), '新しい返事');
  assert.equal(has(env.voiceDir, second.pid, 'done'), true);
  assert.equal(fs.existsSync(h.lockDir(env.workDir)), false, 'ロックが残らない');
  assert.equal(fs.existsSync(h.latestFile(env.workDir, 'tab-A')), true, 'タブの latest-* は消さない（古くなったら片付ける）');
});

test('順番待ちの間にオフにされた返事は、順番が来ても読まれない', async (t) => {
  const env = setup(t);
  fs.mkdirSync(env.workDir);
  const owner = { requestId: 'other-tab', session: 'tab-X' };
  h.plantLock(env.workDir, { ...owner, beatAt: Date.now() });
  const beat = setInterval(() => h.writeState(env.workDir, { ...owner, beatAt: Date.now() }), 300);
  t.after(() => clearInterval(beat));

  const waiting = runSpeak(env, 'tab-B', '待っている返事', 300);
  // 要求が登録されてから（順番待ちに入ってから）オフにする。起動が遅くても、順番待ちを経ずに通ってしまわないように
  await h.waitFor(() => fs.existsSync(h.latestFile(env.workDir, 'tab-B')), 5000, '待っている要求が登録される');
  assert.equal(has(env.voiceDir, waiting.pid, 'started'), false, '別のタブが読んでいる間は読み始めない');
  fs.writeFileSync(path.join(env.dataDir, 'disabled'), '');
  clearInterval(beat);
  fs.rmSync(h.stateFile(env.workDir));
  fs.rmdirSync(h.lockDir(env.workDir)); // 別のタブが読み終わってロックを返す

  assert.equal(await waiting.exited, 0);
  assert.equal(has(env.voiceDir, waiting.pid, 'started'), false, '読まない');
  assert.equal(fs.existsSync(h.lockDir(env.workDir)), false, 'ロックが残らない');
  assert.equal(fs.existsSync(h.latestFile(env.workDir, 'tab-B')), true, 'タブの latest-* は消さない（古くなったら片付ける）');
});

test('読んでいる途中で SIGTERM を受けたら、自分の声を止め、ロックを返して終わる', async (t) => {
  const env = setup(t);
  const reading = runSpeak(env, 'tab-A', '止められる返事', 10000, { FAKE_SIGTERM_AFTER_START: '200' });
  assert.equal(await reading.exited, 0);
  assert.equal(has(env.voiceDir, reading.pid, 'killed'), true, '自分の声を止める');
  assert.equal(fs.existsSync(h.lockDir(env.workDir)), false, 'ロックが残らない');
  assert.equal(fs.existsSync(h.latestFile(env.workDir, 'tab-A')), true, 'タブの latest-* は消さない（古くなったら片付ける）');
});

test('読み上げが時間の上限を超えたら、自分の声を止めてロックを返し、待っていた別のタブが読む', async (t) => {
  const env = setup(t);
  const first = runSpeak(env, 'tab-A', '長い返事', 10000, { FAKE_TIME_LIMIT_MS: '1500' });
  await h.waitFor(() => has(env.voiceDir, first.pid, 'started'), 5000, '長い返事が読み始める');
  const second = runSpeak(env, 'tab-B', '待っている返事', 200);
  await h.waitFor(() => fs.existsSync(h.latestFile(env.workDir, 'tab-B')), 5000, '別のタブの返事が順番待ちに入る');
  assert.equal(has(env.voiceDir, first.pid, 'killed'), false, '別のタブが待ち始めた時点では、まだ上限に届いていない');

  assert.equal(await first.exited, 0);
  assert.equal(await second.exited, 0);
  assert.equal(has(env.voiceDir, first.pid, 'killed'), true, '上限を超えたら自分の声を止める');
  assert.equal(has(env.voiceDir, first.pid, 'done'), false);
  assert.equal(fs.readFileSync(marker(env.voiceDir, second.pid, 'started'), 'utf8'), '待っている返事');
  assert.equal(has(env.voiceDir, second.pid, 'done'), true, '待っていた別のタブが最後まで読む');
  assert.equal(fs.existsSync(h.lockDir(env.workDir)), false, 'ロックが残らない');
});

test('上限より前に読み終わったら止めず、上限のタイマーを残さずにすぐ終わる', { timeout: 30000 }, async (t) => {
  const env = setup(t);
  const started = Date.now();
  const reading = runSpeak(env, 'tab-A', '短い返事', 300, { FAKE_TIME_LIMIT_MS: '60000' });

  assert.equal(await reading.exited, 0);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10000, `上限（60 秒）のタイマーが残っていたら、上限まで終わらない（${elapsed}ms で終わった）`);
  assert.equal(has(env.voiceDir, reading.pid, 'done'), true, '最後まで読む');
  assert.equal(has(env.voiceDir, reading.pid, 'killed'), false, '止めない');
  assert.equal(fs.existsSync(h.lockDir(env.workDir)), false, 'ロックが残らない');
});

test('順番待ちの時間は上限に数えず、上限より長く待っても、自分の番が来たら最後まで読む', async (t) => {
  const env = setup(t);
  const first = runSpeak(env, 'tab-A', '先の返事', 1500);
  await h.waitFor(() => has(env.voiceDir, first.pid, 'started'), 5000, '先の返事が読み始める');
  // 待つ上限も短くする（待っている間に上限を数えてしまう作りだと、読み始める前に終わってしまい、このテストが落ちる）
  const second = runSpeak(env, 'tab-B', '後の返事', 100, { FAKE_TIME_LIMIT_MS: '300', FAKE_STOP_GRACE_MS: '100' });

  assert.equal(await first.exited, 0);
  assert.equal(await second.exited, 0);
  // 順番待ちに入った時刻（latest-* を書いた時刻）から、読み始めた時刻までが、待っていた時間
  const waitedMs =
    fs.statSync(marker(env.voiceDir, second.pid, 'started')).mtimeMs - fs.statSync(h.latestFile(env.workDir, 'tab-B')).mtimeMs;
  assert.ok(waitedMs > 300, `上限（300ms）より長く待った（${Math.round(waitedMs)}ms）`);
  assert.equal(has(env.voiceDir, second.pid, 'done'), true, '最後まで読む');
  assert.equal(has(env.voiceDir, second.pid, 'killed'), false, '待っていた時間では止めない');
});

test('上限を超えて止めても声が終わらないときは、待つ上限のあとにロックを返して終わる', async (t) => {
  const env = setup(t);
  const reading = runSpeak(env, 'tab-A', '止まらない返事', 10000, {
    FAKE_TIME_LIMIT_MS: '300',
    FAKE_STOP_GRACE_MS: '300',
    FAKE_KILL_IGNORED: '1',
  });

  assert.equal(await reading.exited, 0);
  assert.equal(has(env.voiceDir, reading.pid, 'kill-ignored'), true, '上限を超えたら声を止めようとする');
  assert.equal(has(env.voiceDir, reading.pid, 'done'), false, '声が読み終わるのを待たずに終わる');
  assert.equal(fs.existsSync(h.lockDir(env.workDir)), false, 'ロックを返す');
});

test('同じタブの新しい返事で止めても前の声が終わらないときは、待つ上限のあとにロックを返し、新しい返事が読まれる', async (t) => {
  const env = setup(t);
  const first = runSpeak(env, 'tab-A', '前の返事', 10000, { FAKE_STOP_GRACE_MS: '300', FAKE_KILL_IGNORED: '1' });
  await h.waitFor(() => has(env.voiceDir, first.pid, 'started'), 5000, '前の返事が読み始める');
  const second = runSpeak(env, 'tab-A', '新しい返事', 300);

  assert.equal(await first.exited, 0);
  assert.equal(await second.exited, 0);
  assert.equal(has(env.voiceDir, first.pid, 'kill-ignored'), true, '新しい返事に気づいて声を止めようとする');
  assert.equal(has(env.voiceDir, first.pid, 'done'), false, '前の声が読み終わるのを待たずに終わる');
  assert.equal(fs.readFileSync(marker(env.voiceDir, second.pid, 'started'), 'utf8'), '新しい返事');
  assert.equal(has(env.voiceDir, second.pid, 'done'), true, '新しい返事は、あきらめずに最後まで読む');
  assert.equal(fs.existsSync(h.lockDir(env.workDir)), false, 'ロックが残らない');
});

test('読んでいる途中でオフにされても、最後まで読む', async (t) => {
  const env = setup(t);
  const reading = runSpeak(env, 'tab-A', '読んでいる返事', 1500);
  await h.waitFor(() => has(env.voiceDir, reading.pid, 'started'), 5000, '読み始める');
  fs.writeFileSync(path.join(env.dataDir, 'disabled'), '');

  assert.equal(await reading.exited, 0);
  assert.equal(has(env.voiceDir, reading.pid, 'done'), true, '最後まで読む');
  assert.equal(has(env.voiceDir, reading.pid, 'killed'), false);
  assert.equal(fs.existsSync(h.latestFile(env.workDir, 'tab-A')), true, 'タブの latest-* は消さない（古くなったら片付ける）');
});
