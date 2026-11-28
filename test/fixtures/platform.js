/**
 * テスト用: 動いている OS を FAKE_PLATFORM の値にする（node --require で読み込む）
 *
 * 読み上げが動かない OS（linux など）でのふるまいを、どの OS でも確かめるために使う。
 * 読み込むときは、必ず FAKE_PLATFORM を渡す。
 */
'use strict';

Object.defineProperty(process, 'platform', { value: process.env.FAKE_PLATFORM });
