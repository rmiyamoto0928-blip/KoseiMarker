// node tests/parser.test.js で実行
'use strict';
var P = require('../js/parser.js');

var pass = 0, fail = 0;
function eq(actual, expected, label) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { pass++; }
    else { fail++; console.error('FAIL: ' + label + '\n  expected ' + e + '\n  actual   ' + a); }
}

// ---- parseTC ----
eq(P.parseTC('00;00;34;10').precise, true, 'フレーム精度TC');
eq(P.parseTC('0:34').precise, false, '秒精度TC(MM:SS)');
eq(P.parseTC('0:34').ss, 34, 'MM:SS の秒');
eq(P.parseTC('1:02:03').precise, false, '秒精度TC(HH:MM:SS)');
eq(P.parseTC('00:00:10,767'), { kind: 'ms', hh: 0, mm: 0, ss: 10, ms: 767, precise: true, raw: '00:00:10,767' }, 'SRT形式(カンマ)');
eq(P.parseTC('00:00:10.5').ms, 500, 'SRT形式(ドット・桁埋め)');
eq(P.parseTC('abc'), null, '不正TC');
eq(P.parseTC('1;2;3;4;5'), null, '要素過多');
eq(P.parseTC('05;10'), null, 'セミコロン2要素は判別不能(MM;SSかSS;FFか)なので不採用');

// ---- tcToFrame ----
var ndf30 = { fps: 30, nominal: 30, drop: false };
var df2997 = { fps: 30000 / 1001, nominal: 30, drop: true };
eq(P.tcToFrame(P.parseTC('00;01;00;02'), df2997), 1800, 'DF: 1分でフレーム2つ落ち');
eq(P.tcToFrame(P.parseTC('00;10;00;00'), df2997), 17982, 'DF: 10分はスキップしない');
eq(P.tcToFrame(P.parseTC('1:00'), df2997), 1798, '秒精度TCは実時間換算(60s*29.97=1798.2→1798f)');
eq(P.tcToFrame(P.parseTC('10:00'), df2997), 17982, '秒精度TC10分でもズレない(600s*29.97=17982f)');
eq(P.tcToFrame(P.parseTC('1:00'), ndf30), 1800, '秒精度TC 30fpsちょうどなら1800f');
eq(P.tcToFrame(P.parseTC('00:00:10,767'), ndf30), 323, 'ms→フレーム(10.767*30=323.01→323)');
eq(P.tcToFrame(P.parseTC('00;00;05;10'), ndf30), 160, 'フレーム精度 5秒10f');

// ---- parseMdRow ----
eq(P.parseMdRow('| 00;00;28;26 | って【執行錯誤】する | 試行錯誤 |'),
   { tcRaw: '00;00;28;26', cur: 'って【執行錯誤】する', fix: '試行錯誤' }, 'typo-check 3列型');
eq(P.parseMdRow('| 1 | 00:00:10,767 | でもお兄さん絶対<br>彼女7人います【よね】 | でもお兄さん絶対<br>彼女7人います【よね？】 | ルール | 中 |'),
   { tcRaw: '00:00:10,767', cur: 'でもお兄さん絶対 彼女7人います【よね】', fix: 'でもお兄さん絶対 彼女7人います【よね？】' }, '添削指示書 6列型(<br>→空白)');
eq(P.parseMdRow('| タイムコード | 該当テキスト | 修正案 |'), null, 'ヘッダ行は無視');
eq(P.parseMdRow('|---|---|---|'), null, '区切り行は無視');
eq(P.parseMdRow('| 解像度 | ✅ PASS | 1080x1920 | 基準 |'), null, '技術チェック表は無視');
eq(P.parseMdRow('ただの文章'), null, '表以外は無視');

// ---- parseText: 縦並び ----
var v = P.parseText('0:34\nこんにちわ\nこんにちは\n1:02\nありがとうございます');
eq(v.list.length, 2, '縦並び: 2レコード');
eq(v.list[0].cur, 'こんにちわ', '縦並び: 現在');
eq(v.list[0].fix, 'こんにちは', '縦並び: 修正案');
eq(v.list[1].cur, '', '縦並び: 修正案のみ');
eq(v.list[1].fix, 'ありがとうございます', '縦並び: 修正案のみの本文');
eq(v.errs.length, 0, '縦並び: エラーなし');

// ---- parseText: タブ区切り ----
var tb = P.parseText('タイムコード\t現在\t修正案\n00;00;05;10\tこれから向かう現場は\tこれから向かう現場は？');
eq(tb.list.length, 1, 'タブ区切り: ヘッダ除外で1件');
eq(tb.list[0].tc.precise, true, 'タブ区切り: フレーム精度判定');

// ---- parseText: Markdown表の貼り付け（typo-checkレポート） ----
var md = P.parseText('## ファイル名（エンタメ）\n\n検出: **2件**\n\n| タイムコード | 該当テキスト | 修正案 |\n|---|---|---|\n| 00;00;28;26 | って【執行錯誤】する | 試行錯誤 |\n| 00;01;02;00 | 【日出】ずる国 | 日いずる |');
eq(md.list.length, 2, 'md貼り付け: 2件');
eq(md.errs.length > 0, true, 'md貼り付け: 地の文は孤立テキスト扱い(通常モード)');

// ---- parseText: 添削指示書ファイル（tableOnly） ----
var shiji = '# 添削指示書 — 企画3.mp4\n\n## 1. 技術チェック\n\n| 項目 | 判定 | 実測 | 基準 |\n|---|---|---|---|\n| 解像度 | ✅ PASS | 1080x1920 | 基準 |\n\n## 2. テロップ修正（タイムコード順）\n\n| # | タイムコード | 該当テキスト | 修正案 | 理由 | 重要度 |\n|---|---|---|---|---|---|\n| 1 | 00:00:10,767 | います【よね】 | います【よね？】 | ？落とさない | 中 |\n\n地の文はすべて無視されること。\n';
var sf = P.parseText(shiji, { tableOnly: true });
eq(sf.list.length, 1, '添削指示書: テロップ表だけ1件');
eq(sf.list[0].tcRaw, '00:00:10,767', '添削指示書: TC抽出');
eq(sf.list[0].fix, 'います【よね？】', '添削指示書: 修正案抽出');
eq(sf.errs.length, 0, '添削指示書: tableOnlyでエラーなし');

console.log(fail === 0 ? 'ALL PASS (' + pass + ' assertions)' : pass + ' pass / ' + fail + ' FAIL');
process.exit(fail === 0 ? 0 : 1);
