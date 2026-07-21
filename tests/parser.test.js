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

// ---- 範囲TC（開始〜終了）: 開始側を採用 ----
eq(P.parseTCCell('00;00;57;12〜00;01;01;16'), P.parseTC('00;00;57;12'), '範囲TC〜: 開始を採用');
eq(P.parseTCCell('0:34～1:02'), P.parseTC('0:34'), '範囲TC～(全角): 開始を採用');
eq(P.parseTCCell('00;00;10;10'), P.parseTC('00;00;10;10'), '単独TCはそのまま');
eq(P.parseTCCell('00;00;57;12〜メモ'), null, '右側がTCでない〜は範囲扱いしない');

// ---- 実運用サンプル: 範囲TC混在のタブ区切り ----
var real = P.parseText([
    '00;00;10;10\t自分の持ってる本に押す\t持ってる→持っている',
    '00;00;57;12〜00;01;01;16\t押してる時が楽しいのかみたいな\t押してる→押している',
    '00;01;10;18\t合間縫ってやってますからね\tやってます→やっています',
    '00;01;19;17〜00;01;21;14\tやっぱりこれも残ってるところは\t残ってる→残っている',
    '00;01;24;14\tやっぱり残ってるところを\t残ってる→残っている',
    '00;01;40;05\tずっと同じこと考えてると\t考えてる→考えている',
    '00;01;43;08\t無心になってる時にいいアイデアとか\tなってる→なっている'
].join('\n'));
eq(real.list.length, 7, '実サンプル: 7行すべて抽出');
eq(real.errs.length, 0, '実サンプル: エラーなし');
eq(real.list[1].tc.ss, 57, '実サンプル: 範囲行は開始TCで打つ');
eq(real.list[1].tcRaw, '00;00;57;12〜00;01;01;16', '実サンプル: 表示用は範囲のまま保持');
eq(real.list[1].fix, '押してる→押している', '実サンプル: 修正案');

// ---- タブ喪失コピペ対策: TC＋空白での1行完結 ----
var sp = P.parseText('0:34 こんにちわ  こんにちは');
eq(sp.list.length, 1, '空白区切り: 1件抽出');
eq(sp.list[0].cur, 'こんにちわ', '空白区切り: 2連空白で現在/修正を分離');
eq(sp.list[0].fix, 'こんにちは', '空白区切り: 修正案');
var sp1 = P.parseText('00;01;40;05 考えてる→考えている');
eq(sp1.list.length, 1, '空白区切り(分離不能): 1件抽出');
eq(sp1.list[0].fix, '考えてる→考えている', '空白区切り(分離不能): 全体を修正案に');

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

// ---- 修正1: 表のTC付き行が無警告でスキップされない ----
// 修正案セルが空のmd表行 → errsに1件・採用0件（従来は黙ってスキップ）
var emptyFix = P.parseText('| 00;00;05;10 | 該当テキスト |  |', {});
eq(emptyFix.list.length, 0, '修正案空の表行: 採用0件');
eq(emptyFix.errs.length, 1, '修正案空の表行: errsに1件');
eq(emptyFix.stats.mdTcRows, 1, '修正案空の表行: 表TC付き行としてカウント');
eq(emptyFix.stats.mdAdopted, 0, '修正案空の表行: 採用0');

// TC判別不能(05;10)の表行 → errs（見逃し防止）
var ambi = P.parseText('| 05;10 | 該当 | 修正案 |');
eq(ambi.list.length, 0, 'TC判別不能の表行: 採用0件');
eq(ambi.errs.length, 1, 'TC判別不能の表行: errsに1件');

// エスケープ \| を含む行が列ズレせず正しく採用される（従来は列がズレて修正案を取り違え）
var escRow = P.parseMdRow('| 00;00;05;10 | A\\|B | 修正後C |');
eq(escRow, { tcRaw: '00;00;05;10', cur: 'A|B', fix: '修正後C' }, 'エスケープパイプ: 列ズレせず修正案を正しく抽出');

// stats: 表TC行数 vs 採用件数（不一致検知）
var st = P.parseText('| 00;00;05;10 | a | fixA |\n| 00;00;06;00 | b |  |', {});
eq(st.stats.mdTcRows, 2, 'stats: 表TC付き行2');
eq(st.stats.mdAdopted, 1, 'stats: 採用1');
eq(st.list.length, 1, 'stats: listは採用分のみ');

// 技術チェック表・ヘッダはerrsに載せない（stats.mdTcRows=0）
var tech = P.parseText('| 項目 | 判定 | 実測 |\n|---|---|---|\n| 解像度 | ✅ PASS | 1080x1920 |', { tableOnly: true });
eq(tech.errs.length, 0, '技術チェック表: errsなし');
eq(tech.stats.mdTcRows, 0, '技術チェック表: 表TC付き行0');

// ---- K2-6: 列数の厳密化・エスケープの正しい解釈 ----
// 末尾セル内の escaped \| を境界除去せず、リテラル | として保持する（従来は \|+$ で食い違い）
eq(P.parseMdRow('| 00;00;05;10 | 該当 | 修正案\\| |'),
   { tcRaw: '00;00;05;10', cur: '該当', fix: '修正案|' }, 'K2-6: 末尾セル内の escaped パイプを保持');
// 末尾に境界パイプが無く escaped \| で終わる行（従来は \|+$ が escaped パイプを誤除去）
eq(P.parseMdRow('| 00;00;05;10 | 該当 | 修正案\\|'),
   { tcRaw: '00;00;05;10', cur: '該当', fix: '修正案|' }, 'K2-6: 末尾 escaped パイプで境界誤除去しない');
// 3列型で余分な列がある行 → error（従来は余分列を無視して採用＝列ズレ誤採用）
var extra3 = P.parseText('| 00;00;05;10 | 該当 | 修正 | 余分 |');
eq(extra3.list.length, 0, 'K2-6: 3列型+余分列は不採用');
eq(extra3.errs.length, 1, 'K2-6: 3列型+余分列は error');
// 3列型で列不足 → error
var short3 = P.parseText('| 00;00;05;10 | 修正のみ |');
eq(short3.list.length, 0, 'K2-6: 3列型で列不足は不採用');
eq(short3.errs.length, 1, 'K2-6: 3列型で列不足は error');
// 6列型で列不足（5列）→ error（従来は length>=4 で誤採用）
var short6 = P.parseText('| 1 | 00;00;05;10 | 該当 | 修正 | 理由 |');
eq(short6.list.length, 0, 'K2-6: 6列型で列不足は不採用');
eq(short6.errs.length, 1, 'K2-6: 6列型で列不足は error');
// 6列型で列超過（7列）→ error
var long6 = P.parseText('| 1 | 00;00;05;10 | 該当 | 修正 | 理由 | 重要 | 余分 |');
eq(long6.list.length, 0, 'K2-6: 6列型で列超過は不採用');
eq(long6.errs.length, 1, 'K2-6: 6列型で列超過は error');
// 技術チェック表(4列)は引き続き ignore（error にしない）
var tech4 = P.parseText('| 項目 | 判定 | 実測 | 基準 |\n| 解像度 | ✅ PASS | 1080x1920 | 基準 |', { tableOnly: true });
eq(tech4.errs.length, 0, 'K2-6: 技術チェック表(4列)は error にしない');

// ---- K2-7: parseTC の範囲検証 ----
eq(P.parseTC('00:99:99'), null, 'K2-7: 分/秒>=60 は無効(SRT/コロン)');
eq(P.parseTC('00;00;61;00'), null, 'K2-7: 秒>=60 は無効(セミコロン)');
eq(P.parseTC('00;61;00;00'), null, 'K2-7: 分>=60 は無効');
eq(P.parseTC('00;00;00;40', 30), null, 'K2-7: フレーム>=公称fps は無効');
eq(P.parseTC('00;00;00;29', 30).ff, 29, 'K2-7: フレーム<fps は有効');
eq(P.parseTC('00;00;00;40').ff, 40, 'K2-7: fps未指定ならフレーム検証しない');
var rng = P.parseText('| 00:99:99 | 該当 | 修正 |');
eq(rng.list.length, 0, 'K2-7: 範囲外TC行は不採用');
eq(rng.errs.length, 1, 'K2-7: 範囲外TC行は error');
var frov = P.parseText('| 00;00;00;40 | 該当 | 修正 |', { fps: 30 });
eq(frov.list.length, 0, 'K2-7: フレーム超過行は不採用');
eq(frov.errs.length, 1, 'K2-7: フレーム超過行は error');

// ---- K3-4/K3-5/K3-6: 署名＋チェックサム付きゼロ幅一意IDコーデック（パネル/host共通規則の参照実装） ----
// 所有IDは (runId, k) の2要素。encodeId(runId,k) → decodeId は正準文字列 "runId:k" を返す（非所有は null）。
var ZW0 = '​', ZW1 = '‌', ZWF = '⁠';
var SIG = '11001010111100001101';        // KMID_SIG と厳密一致（変えたら parser.js/hostscript.jsx も要同期）
function zw(bits) { var s = ''; for (var i = 0; i < bits.length; i++) { s += (bits.charAt(i) === '1' ? ZW1 : ZW0); } return s; }
function bin(n) { if (n === 0) { return '0'; } var s = '', x = n; while (x > 0) { s = (x % 2) + s; x = Math.floor(x / 2); } return s; }
function cksum(r, k) { var Pm = 1000003; var a = r % Pm, b = k % Pm; return (a * 31 + b * 17 + 12345) % Pm; }
function throws(fn, label) { var t = false; try { fn(); } catch (e) { t = true; } eq(t, true, label); }

var enc = P.encodeId(1750000000000, 5);
eq(P.decodeId('校正 00;00;05;10' + enc), '1750000000000:5', 'KMID: encode→decode 往復（署名＋チェックサム）');
eq(P.stripId('校正 00;00;05;10' + enc), '校正 00;00;05;10', 'KMID: 表示用にゼロ幅ID除去');
eq(P.isOwned('校正 00;00;05;10' + enc), true, 'KMID: 所有判定 true');
eq(P.isOwned('校正 00;00;05;10'), false, 'KMID: 素の名前は所有でない');
eq(P.isOwned('校正 00;00;05;10​#KMK'), false, 'KMID: 旧#KMKタグは新方式では所有でない');
eq(P.decodeId('校正メモ'), null, 'KMID: ID無しは null');
eq(P.stripId('校正メモ'), '校正メモ', 'KMID: ID無しは元の名前をそのまま返す');
eq(P.decodeId('x' + P.encodeId(0, 0)), '0:0', 'KMID: (0,0) の往復');
eq(P.decodeId('x' + P.encodeId(1750000000000, 4200)), '1750000000000:4200', 'KMID: 大きなrunId往復');

// K3-5: runId と k を別フィールド符号化。旧 runId*1000+k の衝突ペア（t,k=1000 と t+1,k=0）が別IDになること
var idA = P.decodeId('n' + P.encodeId(1000, 1000));
var idB = P.decodeId('n' + P.encodeId(1001, 0));
eq(idA, '1000:1000', 'K3-5: (1000,1000) の復号');
eq(idB, '1001:0', 'K3-5: (1001,0) の復号');
eq(idA !== idB, true, 'K3-5: 掛け算衝突ペアが別IDになる（衝突しない一意ID）');

// K3-4: 単なる形一致（署名なし FRAME+bits+FRAME）は所有と判定しない
eq(P.isOwned('x' + ZWF + ZW1 + ZW0 + ZW1 + ZWF), false, 'K3-4: 署名なしの形一致は非所有');

// K3-4: 手組みの正準タグは所有。チェックサム改変・非正準（先頭ゼロ埋め）は非所有
var r0 = 42, k0 = 3, cs0 = cksum(r0, k0);
var canonTag = ZWF + zw(SIG) + ZWF + zw(bin(r0)) + ZWF + zw(bin(k0)) + ZWF + zw(bin(cs0)) + ZWF;
eq(P.isOwned('z' + canonTag), true, 'K3-4: 手組み正準タグは所有');
eq(P.decodeId('z' + canonTag), '42:3', 'K3-4: 手組み正準タグの復号');
var badCsTag = ZWF + zw(SIG) + ZWF + zw(bin(r0)) + ZWF + zw(bin(k0)) + ZWF + zw(bin((cs0 + 1) % 1000003)) + ZWF;
eq(P.isOwned('z' + badCsTag), false, 'K3-4: チェックサム不一致は非所有');
var nonCanonTag = ZWF + zw(SIG) + ZWF + zw('0' + bin(r0)) + ZWF + zw(bin(k0)) + ZWF + zw(bin(cs0)) + ZWF;
eq(P.isOwned('z' + nonCanonTag), false, 'K3-4: 非正準（先頭ゼロ埋め）は非所有');
var badSigTag = ZWF + zw('00000000000000000000') + ZWF + zw(bin(r0)) + ZWF + zw(bin(k0)) + ZWF + zw(bin(cs0)) + ZWF;
eq(P.isOwned('z' + badSigTag), false, 'K3-4: 署名不一致は非所有');

// K3-6: encodeId は Infinity/NaN/負数/非整数/空 で例外（無限ループ・破損を防ぐ）
throws(function () { P.encodeId(Infinity, 0); }, 'K3-6: Infinity は例外');
throws(function () { P.encodeId(NaN, 0); }, 'K3-6: NaN は例外');
throws(function () { P.encodeId(-1, 0); }, 'K3-6: 負数は例外');
throws(function () { P.encodeId(1.5, 0); }, 'K3-6: 非整数は例外');
throws(function () { P.encodeId('', 0); }, 'K3-6: 空 runId は例外');
throws(function () { P.encodeId(5, ''); }, 'K3-6: 空 k は例外');

// K3-6: safeNonNegInt は「空でない安全な非負整数」だけ受理
eq(P.safeNonNegInt(''), null, 'K3-6: 空文字は非受理（Number("")===0 の罠を防ぐ）');
eq(P.safeNonNegInt('0'), 0, 'K3-6: 0 は受理');
eq(P.safeNonNegInt('12'), 12, 'K3-6: 正整数受理');
eq(P.safeNonNegInt('-3'), null, 'K3-6: 負数は非受理');
eq(P.safeNonNegInt('1.5'), null, 'K3-6: 小数は非受理');
eq(P.safeNonNegInt('abc'), null, 'K3-6: 非数字は非受理');
eq(P.safeNonNegInt(' 3'), null, 'K3-6: 前後空白は非受理');
eq(P.safeNonNegInt(9007199254740992), null, 'K3-6: 2^53 超は非受理');

// ---- K4-4: 復号IDの安全整数検証（2^53超・非正準の再エンコード不一致は非所有） ----
// 正: 安全整数上限ちょうど（2^53-1）は正準に往復し所有と認める
var maxV = 9007199254740991; // 2^53-1（53個の1）
var maxCs = cksum(maxV, 0);
var maxTag = ZWF + zw(SIG) + ZWF + zw(bin(maxV)) + ZWF + zw(bin(0)) + ZWF + zw(bin(maxCs)) + ZWF;
eq(P.isOwned('z' + maxTag), true, 'K4-4: 2^53-1（安全整数上限）は所有として受理');
eq(P.decodeId('z' + maxTag), '9007199254740991:0', 'K4-4: 上限値の復号が正準');
// 誤: 2^53（安全整数上限超）は、チェックサムを正しく合わせても非所有にする
var overV = 9007199254740992; // 2^53
var overCs = cksum(overV, 0); // 正しいチェックサムを付けてもK4-4上限で弾く
var overTag = ZWF + zw(SIG) + ZWF + zw(bin(overV)) + ZWF + zw(bin(0)) + ZWF + zw(bin(overCs)) + ZWF;
eq(P.isOwned('z' + overTag), false, 'K4-4: 2^53超はチェックサム一致でも非所有');
eq(P.decodeId('z' + overTag), null, 'K4-4: 2^53超は復号しない');

// ---- K4-5: タグのフィールド数厳密化（余分フィールドを持つ細工タグを弾く） ----
var r5 = 7, k5 = 2, cs5 = cksum(r5, k5);
// 正規（5フレーム＝split後6要素）は所有
var okTag = ZWF + zw(SIG) + ZWF + zw(bin(r5)) + ZWF + zw(bin(k5)) + ZWF + zw(bin(cs5)) + ZWF;
eq(P.isOwned('z' + okTag), true, 'K4-5: 正規フィールド数のタグは所有');
// 余分フィールドを1つ足す（split後7要素）→ 非所有
var extraFieldTag = ZWF + zw(SIG) + ZWF + zw(bin(r5)) + ZWF + zw(bin(k5)) + ZWF + zw(bin(cs5)) + ZWF + zw(bin(1)) + ZWF;
eq(P.isOwned('z' + extraFieldTag), false, 'K4-5: 余分フィールドを持つタグは非所有');

console.log(fail === 0 ? 'ALL PASS (' + pass + ' assertions)' : pass + ' pass / ' + fail + ' FAIL');
process.exit(fail === 0 ? 0 : 1);
