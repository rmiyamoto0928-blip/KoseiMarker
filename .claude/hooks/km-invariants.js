#!/usr/bin/env node
// 校正マーカーの「テストでは落ちない不変条件」を静的にチェックする。
//   1) ゼロ幅IDコーデックの定数が parser.js / hostscript.jsx / tests で一致しているか
//   2) hostscript.jsx が ES3 制約（const/let/アロー/テンプレート文字列を使わない）を守っているか
// 終了コード: 0=OK / 1=違反あり
'use strict';

var fs = require('fs');
var path = require('path');

var root = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '..', '..');
var P = path.join(root, 'js', 'parser.js');
var H = path.join(root, 'js', 'hostscript.jsx');
var T = path.join(root, 'tests', 'parser.test.js');

function read(f) {
    try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; }
}

var parser = read(P), host = read(H), test = read(T);
var problems = [];

if (parser === null || host === null || test === null) {
    console.log('不変条件チェック: 対象ファイルを読めませんでした（js/parser.js, js/hostscript.jsx, tests/parser.test.js）');
    process.exit(0); // ファイル構成が変わっただけの場合に誤検知しない
}

// ---- 1) コーデック定数の3点同期 ----
function pick(src, re) {
    var m = src.match(re);
    return m ? m[1] : null;
}

var sigParser = pick(parser, /KMID_SIG\s*=\s*['"]([01]+)['"]/);
var sigHost = pick(host, /KMID_SIG\s*=\s*['"]([01]+)['"]/);
if (sigParser && sigHost && sigParser !== sigHost) {
    problems.push('KMID_SIG が parser.js と hostscript.jsx で不一致（' + sigParser + ' vs ' + sigHost + '）。所有マーカーを認識できなくなる。');
}
if (sigParser && test.indexOf(sigParser) === -1) {
    problems.push('KMID_SIG を tests/parser.test.js が追随していない（テスト側の SIG も同じ値に更新すること）。');
}

var ckpParser = pick(parser, /KMID_CKP\s*=\s*(\d+)/);
var ckpHost = pick(host, /KMID_CKP\s*=\s*(\d+)/);
if (ckpParser && ckpHost && ckpParser !== ckpHost) {
    problems.push('KMID_CKP（チェックサム法）が parser.js と hostscript.jsx で不一致（' + ckpParser + ' vs ' + ckpHost + '）。');
}
if (ckpParser && test.indexOf(ckpParser) === -1) {
    problems.push('KMID_CKP を tests/parser.test.js が追随していない。');
}

// チェックサム式（係数）の一致。空白差は無視して比較する。
function cksumExpr(src) {
    var m = src.match(/a\s*\*\s*(\d+)\s*\+\s*b\s*\*\s*(\d+)\s*\+\s*(\d+)/);
    return m ? m[1] + '/' + m[2] + '/' + m[3] : null;
}
var exprs = { 'parser.js': cksumExpr(parser), 'hostscript.jsx': cksumExpr(host), 'tests/parser.test.js': cksumExpr(test) };
var exprVals = Object.keys(exprs).filter(function (k) { return exprs[k]; }).map(function (k) { return exprs[k]; });
if (exprVals.length >= 2 && exprVals.some(function (v) { return v !== exprVals[0]; })) {
    problems.push('チェックサム式の係数が3ファイルで不一致（' +
        Object.keys(exprs).map(function (k) { return k + '=' + exprs[k]; }).join(' / ') + '）。');
}

// ゼロ幅文字の割り当て（枠=U+2060 / 0=U+200B / 1=U+200C）
[['\\u2060', 'FRAME'], ['\\u200B', 'ZERO'], ['\\u200C', 'ONE']].forEach(function (pair) {
    var esc = pair[0], label = pair[1];
    var inParser = parser.indexOf(esc) !== -1 || parser.indexOf(esc.toLowerCase()) !== -1;
    var inHost = host.indexOf(esc) !== -1 || host.indexOf(esc.toLowerCase()) !== -1;
    if (inParser !== inHost) {
        problems.push('ゼロ幅文字 ' + esc + '（' + label + '）の使用が parser.js と hostscript.jsx で食い違っている。');
    }
});

// ---- 2) hostscript.jsx の ES3 制約 ----
// 文字列/コメント中の誤検知を避けるため、行コメントと文字列リテラルを落としてから見る。
var hostCode = host
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map(function (line) { return line.replace(/\/\/.*$/, ''); })
    .join('\n')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');

var es3 = [
    [/(^|[^.\w$])const\s+[A-Za-z_$]/m, 'const 宣言'],
    [/(^|[^.\w$])let\s+[A-Za-z_$]/m, 'let 宣言'],
    [/=>/, 'アロー関数'],
    [/`/, 'テンプレート文字列']
];
es3.forEach(function (rule) {
    if (rule[0].test(hostCode)) {
        problems.push('js/hostscript.jsx に ' + rule[1] + ' がある。ExtendScript(ES3) では動かないので var / function に直すこと。');
    }
});

if (problems.length === 0) {
    console.log('不変条件チェックOK（コーデック定数3点同期・hostscript の ES3 制約）');
    process.exit(0);
}
console.log('不変条件チェックで問題を検出:');
problems.forEach(function (p) { console.log('  - ' + p); });
process.exit(1);
