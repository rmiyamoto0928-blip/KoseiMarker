// node tests/textdiag.test.js で実行
// diag/textdiag.jsx（ExtendScript・診断専用）を node 上で擬似実行し、
// Premiere の TrackItem / Component / ComponentParam API をモックして次を検証する:
//   - 出力が必ず妥当な JSON になる（手組みJSONのエスケープ含む）
//   - VideoTrack → TrackItem → Component → ComponentParam を全部走査する
//   - テスト文字列（needle）が「どこに在ったか」を正しく報告する
//   - エラーを握りつぶさず、レコードとして残す
//   - バイナリ値・巨大値を安全に省略する
//   - Source Text が JSON 文字列で返る場合に本文候補キーを抽出する
// ※ 実機（Premiere）の挙動そのものは検証できない。ここで確かめるのは診断コードの健全性のみ。
'use strict';
var fs = require('fs');
var path = require('path');

var pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; } else { fail++; console.error('FAIL: ' + label); } }
function eq(a, b, label) { ok(a === b, label + '  (actual=' + JSON.stringify(a) + ' expected=' + JSON.stringify(b) + ')'); }
// JSON.parse を投げっぱなしにせず、失敗を FAIL として記録する（1件の壊れで全体が中断しないように）
function jp(s, label) {
    try { return JSON.parse(s); }
    catch (e) { fail++; console.error('FAIL: ' + label + '  JSONパース不能: ' + String(e && e.message ? e.message : e)); return null; }
}

var TICKS = 254016000000;
var NEEDLE = 'TEXT_EXTRACT_TEST_12345';

// ---------------------------------------------------------------- モック部品
function mkTime(sec) { return { ticks: String(Math.round(sec * TICKS)), seconds: sec }; }

// ComponentParam。getValue は valueFn の戻り値／throw をそのまま再現する。
function mkParam(name, displayName, valueFn, opts) {
    opts = opts || {};
    return {
        name: name,
        displayName: displayName,
        getValue: function () { return valueFn(); },
        getValueAtTime: function () {
            if (opts.atTimeThrows) { throw new Error('getValueAtTime 未対応'); }
            return valueFn();
        },
        isTimeVarying: function () { return !!opts.timeVarying; },
        areKeyframesSupported: function () { return !!opts.keyframes }
    };
}

// ComponentParamCollection（配列様 + numItems + getParamForDisplayName）
function mkProps(params, opts) {
    opts = opts || {};
    var col = { numItems: params.length };
    for (var i = 0; i < params.length; i++) { col[i] = params[i]; }
    if (!opts.noGetParamForDisplayName) {
        col.getParamForDisplayName = function (dn) {
            for (var j = 0; j < params.length; j++) {
                if (params[j].displayName === dn) { return params[j]; }
            }
            return null;
        };
    }
    return col;
}

function mkComponent(matchName, displayName, params, opts) {
    return { matchName: matchName, displayName: displayName, properties: mkProps(params, opts) };
}

function mkComponents(list) {
    var col = { numItems: list.length };
    for (var i = 0; i < list.length; i++) { col[i] = list[i]; }
    return col;
}

function mkProjectItem(name, opts) {
    opts = opts || {};
    return {
        name: name,
        nodeId: opts.nodeId || ('pi-' + name),
        type: opts.type === undefined ? 1 : opts.type,
        isSequence: function () { return !!opts.isSequence; },
        getMediaPath: function () { return opts.mediaPath || ''; },
        videoComponents: function () { return { numItems: opts.videoComponentCount || 0 }; }
    };
}

function mkClip(name, startSec, endSec, components, opts) {
    opts = opts || {};
    return {
        name: name,
        matchName: opts.matchName || 'AE.ADBE Vector Motion',
        nodeId: opts.nodeId || ('node-' + name),
        mediaType: 'Video',
        type: 1,
        disabled: !!opts.disabled,
        start: mkTime(startSec),
        end: mkTime(endSec),
        inPoint: mkTime(0),
        outPoint: mkTime(endSec - startSec),
        duration: mkTime(endSec - startSec),
        projectItem: opts.projectItem || mkProjectItem(name),
        components: mkComponents(components || []),
        getMatchName: function () { return opts.matchName || 'AE.ADBE Vector Motion'; },
        isAdjustmentLayer: function () { return !!opts.adjustment; },
        isSelected: function () { return !!opts.selected; },
        getSpeed: function () { return 1; },
        getMGTComponent: function () {
            if (opts.mgtThrows) { throw new Error('getMGTComponent 失敗'); }
            return opts.mgt === undefined ? null : opts.mgt;
        }
    };
}

function mkTrack(name, clips) {
    var col = { numItems: clips.length };
    for (var i = 0; i < clips.length; i++) { col[i] = clips[i]; }
    return { name: name, isMuted: function () { return false; }, clips: col };
}

function mkSeq(tracks) {
    var vt = { numTracks: tracks.length };
    for (var i = 0; i < tracks.length; i++) { vt[i] = tracks[i]; }
    return {
        name: 'DiagMockSeq',
        sequenceID: 'SEQ-GUID-1',
        timebase: String(TICKS / 30),
        zeroPoint: '0',
        videoDisplayFormat: '110',
        videoTracks: vt,
        audioTracks: { numTracks: 2 }
    };
}

// ---------------------------------------------------------------- ロード
// diag/textdiag.jsx はトップレベルで app / $ / Folder / File を参照しないので、
// Function に body を渡して外部依存を引数注入する（tests/host.test.js と同じ方式）。
var src = fs.readFileSync(path.join(__dirname, '..', 'diag', 'textdiag.jsx'), 'utf8');

var written = {}; // path -> content（File の書き出しを捕捉）
function FileMock(p) {
    this.path = p;
    this.encoding = '';
    this._buf = '';
    var self = this;
    this.open = function () { return true; };
    this.write = function (s) { self._buf += s; };
    this.close = function () { written[p] = self._buf; return true; };
}
var FolderMock = { desktop: { fsName: '/tmp/mock-desktop' } };
var DollarMock = { locale: 'ja_JP', version: '4.5.5', os: 'Macintosh OS 14' };

function load(appBox) {
    var factory = new Function('app', '$', 'Folder', 'File',
        src + '\n;return { kmDiagRun: kmDiagRun, kmdJstr: kmdJstr, kmdIsBinaryish: kmdIsBinaryish, ' +
        'kmdLooksJson: kmdLooksJson, kmdJsonTextKeys: kmdJsonTextKeys };');
    return factory(appBox, DollarMock, FolderMock, FileMock);
}

// ---------------------------------------------------------------- 1. 純粋関数
(function testPureHelpers() {
    var D = load({ project: { activeSequence: null } });

    // JSON エスケープ: 制御文字・U+2028/2029・引用符・バックスラッシュ
    eq(jp(D.kmdJstr('a"b\\c'), 'jstr'), 'a"b\\c', 'jstr: 引用符とバックスラッシュ');
    eq(jp(D.kmdJstr('1\n2\t3\r4'), 'jstr'), '1\n2\t3\r4', 'jstr: 改行/タブ/CR');
    eq(jp(D.kmdJstr('x\u2028y\u2029z'), 'jstr'), 'x\u2028y\u2029z', 'jstr: U+2028/2029（JS行終端子）');
    eq(jp(D.kmdJstr('\u0001\u001f'), 'jstr'), '\u0001\u001f', 'jstr: 制御文字');
    eq(jp(D.kmdJstr('日本語＋English＋123'), 'jstr'), '日本語＋English＋123', 'jstr: 日英数混在');
    eq(jp(D.kmdJstr('絵文字😀'), 'jstr'), '絵文字😀', 'jstr: サロゲートペア');

    // バイナリ判定
    ok(D.kmdIsBinaryish('a\u0000b'), 'binaryish: NUL を含む');
    ok(!D.kmdIsBinaryish('普通のテキスト\n2行目'), 'binaryish: 通常テキストは false');
    ok(!D.kmdIsBinaryish(''), 'binaryish: 空文字は false');

    // JSONらしさ
    ok(D.kmdLooksJson('  {"a":1} '), 'looksJson: オブジェクト');
    ok(D.kmdLooksJson('[1,2]'), 'looksJson: 配列');
    ok(!D.kmdLooksJson('お問い合わせはこちら'), 'looksJson: 素のテキストは false');

    // Source Text が JSON で返るケースの本文候補抽出
    var srcTextJson = '{"mTextParam":{"textEditValue":"お問い合わせは\\nこちら","fontTextRunLength":10,"mRawText":"生テキスト"}}';
    var keys = D.kmdJsonTextKeys(srcTextJson);
    var byKey = {};
    for (var i = 0; i < keys.length; i++) { byKey[keys[i].key] = keys[i].value; }
    eq(byKey.textEditValue, 'お問い合わせは\nこちら', 'jsonTextKeys: textEditValue を改行込みで抽出');
    eq(byKey.mRawText, '生テキスト', 'jsonTextKeys: mRawText を抽出');
    ok(!('fontTextRunLength' in byKey), 'jsonTextKeys: text を含まないキーは拾わない');
})();

// ---------------------------------------------------------------- 2. シーケンス無し
(function testNoSequence() {
    var D = load({ project: { activeSequence: null } });
    var r = jp(D.kmDiagRun('', NEEDLE, 0, 'full'), 'kmDiagRun戻り値');
    eq(r.error, 'アクティブなシーケンスがありません', 'シーケンス無し: エラーを返す');
})();

// ---------------------------------------------------------------- 3. フル走査
(function testFullWalk() {
    written = {};

    // A: Premiere ネイティブテキスト風。Source Text が JSON 文字列で返る。
    var srcTextVal = '{"mTextParam":{"textEditValue":"' + NEEDLE + '","fontTextRunLength":23}}';
    var graphicsComp = mkComponent('AE.ADBE Text', 'グラフィック', [
        mkParam('Source Text', 'ソーステキスト', function () { return srcTextVal; }),
        mkParam('Transform', '変形', function () { return 1.0; })
    ]);
    var motionComp = mkComponent('AE.ADBE Motion', 'モーション', [
        mkParam('Position', '位置', function () { return [960, 540]; }),
        mkParam('Scale', 'スケール', function () { return 100; })
    ]);
    var clipA = mkClip('テロップA', 1.0, 3.0, [motionComp, graphicsComp], { matchName: 'AE.ADBE Text' });

    // B: AE製MOGRT風。getMGTComponent() が component を返し、本文は素の string。
    var mgtComp = mkComponent('AE.ADBE MGT', 'Motion Graphics Template', [
        mkParam('Source Text', 'Source Text', function () { return 'AE MOGRT 本文'; }),
        mkParam('Color', 'Color', function () { return [255, 0, 0, 255]; })
    ]);
    var clipB = mkClip('MOGRT_B', 5.0, 7.5, [motionComp], { mgt: mgtComp });

    // C: エラーを出すクリップ（getValue が throw / getMGTComponent が throw）
    var badComp = mkComponent('AE.ADBE Broken', '壊れたコンポーネント', [
        mkParam('Boom', '爆発', function () { throw new Error('値取得に失敗'); }, { atTimeThrows: true })
    ]);
    var clipC = mkClip('壊れクリップ', 9.0, 10.0, [badComp], { mgtThrows: true });

    // D: バイナリ値・巨大値
    var bigText = new Array(9000).join('あ');       // 8999文字
    var binVal = 'head\u0000\u0001\u0002\u0003tail';
    var heavyComp = mkComponent('AE.ADBE Heavy', '重いコンポーネント', [
        mkParam('Big', '巨大', function () { return bigText; }),
        mkParam('Bin', 'バイナリ', function () { return binVal; })
    ]);
    // 無効化クリップ＋ネスト（projectItem.isSequence()=true）
    var clipD = mkClip('ネスト無効クリップ', 12.0, 14.0, [heavyComp], {
        disabled: true,
        projectItem: mkProjectItem('ネストシーケンス', { isSequence: true, videoComponentCount: 3 })
    });

    var seq = mkSeq([
        mkTrack('V1', [clipA, clipB]),
        mkTrack('V2', [clipC, clipD])
    ]);
    var D = load({ project: { activeSequence: seq } });

    var sum = jp(D.kmDiagRun('/tmp/mock-desktop/diag.json', NEEDLE, 0, 'full'), 'kmDiagRun戻り値');
    eq(sum.ok, 1, 'サマリ: ok');
    eq(sum.wrote, true, 'サマリ: ファイル書き出し成功');
    eq(sum.path, '/tmp/mock-desktop/diag.json', 'サマリ: 出力パス');
    eq(sum.videoTrackCount, 2, 'サマリ: Videoトラック数');
    eq(sum.totalClips, 4, 'サマリ: 総クリップ数');
    eq(sum.scannedClips, 4, 'サマリ: 走査クリップ数');
    eq(sum.truncated, false, 'サマリ: 打ち切りなし');

    // ---- レポート本体が妥当な JSON であること（最重要） ----
    var raw = written['/tmp/mock-desktop/diag.json'];
    ok(!!raw, 'レポートが書き出されている');
    var rep = null, parseErr = null;
    try { rep = JSON.parse(raw); } catch (e) { parseErr = String(e); }
    ok(rep !== null, 'レポートが妥当な JSON としてパースできる  ' + (parseErr || ''));
    if (!rep) { return; }

    eq(rep.schema, 'koseimarker.textdiag/1', 'レポート: schema');
    eq(rep.valueMode, 'full', 'レポート: valueMode');
    eq(rep.sequence.name.value, 'DiagMockSeq', 'レポート: シーケンス名');
    eq(Math.round(rep.sequence.fps), 30, 'レポート: fps 算出');
    eq(rep.host.locale.value, 'ja_JP', 'レポート: ロケール記録（displayNameの言語判定に使う）');
    eq(rep.tracks.length, 2, 'レポート: トラック2本');
    eq(rep.tracks[0].clips.length, 2, 'レポート: V1 に2クリップ');
    eq(rep.tracks[1].clips.length, 2, 'レポート: V2 に2クリップ');

    // ---- A: Graphics component と Source Text の本文抽出 ----
    var a = rep.tracks[0].clips[0];
    eq(a.name, 'テロップA', 'A: クリップ名');
    eq(a.componentCount, 2, 'A: component 2件');
    var gc = null;
    for (var i = 0; i < a.components.length; i++) {
        if (a.components[i].matchName === 'AE.ADBE Text') { gc = a.components[i]; }
    }
    ok(gc !== null, 'A: AE.ADBE Text component を発見');
    eq(gc.paramCount, 2, 'A: param 2件');
    eq(gc.params[0].displayName, 'ソーステキスト', 'A: param displayName（日本語UI想定）');
    var gv = gc.params[0].calls[0];
    eq(gv.call, 'getValue()', 'A: getValue() を呼んでいる');
    eq(gv.ok, true, 'A: getValue() 成功');
    eq(gv.type, 'string', 'A: 値の型は string');
    eq(gv.looksJson, true, 'A: JSON らしいと判定');
    eq(gv.needleFound, true, 'A: needle を値の中で検出');
    ok(!!gv.jsonTextKeys, 'A: jsonTextKeys を抽出');
    eq(gv.jsonTextKeys[0].key, 'textEditValue', 'A: 本文キーは textEditValue');
    eq(gv.jsonTextKeys[0].value, NEEDLE, 'A: 本文が needle と一致');

    // 配列値（Position）も壊れず記録される
    var mc = a.components[0];
    eq(mc.matchName, 'AE.ADBE Motion', 'A: 先頭は Motion');
    eq(mc.params[0].calls[0].arrayLike, true, 'A: Position は配列として記録');
    eq(mc.params[0].calls[0].array.length, 2, 'A: Position は2要素');

    // getParamForDisplayName の存在と結果が記録される
    ok(gc.byDisplayName.length >= 2, 'A: byDisplayName プローブが記録されている');
    var probeJa = null, probeEn = null;
    for (var p = 0; p < gc.byDisplayName.length; p++) {
        if (gc.byDisplayName[p].displayName === 'ソーステキスト') { probeJa = gc.byDisplayName[p]; }
        if (gc.byDisplayName[p].displayName === 'Source Text') { probeEn = gc.byDisplayName[p]; }
    }
    eq(probeJa.found, true, 'A: 日本語 displayName で引ける');
    eq(probeEn.found, false, 'A: 英語 displayName では引けない（ローカライズの罠を可視化）');

    // ---- B: MOGRT ----
    var b = rep.tracks[0].clips[1];
    eq(b.mgt.available, true, 'B: getMGTComponent が存在');
    eq(b.mgt.component.matchName, 'AE.ADBE MGT', 'B: MGT component の matchName');
    eq(b.mgt.component.params[0].calls[0].value, 'AE MOGRT 本文', 'B: MOGRT本文を素の string で取得');
    eq(b.mgt.component.params[0].calls[0].looksJson, false, 'B: MOGRT本文は JSON ではない');

    // ---- C: エラーを握りつぶさない ----
    var c = rep.tracks[1].clips[0];
    eq(c.mgt.available, false, 'C: getMGTComponent の失敗を記録');
    eq(c.mgt.error, 'getMGTComponent 失敗', 'C: MGT エラー内容を保持');
    var boom = c.components[0].params[0];
    eq(boom.calls[0].ok, false, 'C: getValue() の失敗を ok=false で記録');
    eq(boom.calls[0].error, '値取得に失敗', 'C: getValue() のエラー内容を保持');
    eq(boom.calls[1].ok, false, 'C: getValueAtTime() の失敗も記録');
    eq(boom.calls[1].error, 'getValueAtTime 未対応', 'C: getValueAtTime のエラー内容を保持');

    // ---- D: 巨大値の切り詰め / バイナリ省略 / ネスト / 無効クリップ ----
    var d = rep.tracks[1].clips[1];
    eq(d.disabled.value, true, 'D: 無効クリップを検出');
    eq(d.projectItem.isSequence.value, true, 'D: ネスト（projectItem がシーケンス）を検出');
    eq(d.projectItem.videoComponents.value, 3, 'D: マスタークリップ側 component 数も記録');
    var big = d.components[0].params[0].calls[0];
    eq(big.truncated, true, 'D: 巨大値は truncated フラグ付き');
    eq(big.len, 8999, 'D: 元の長さを保持');
    eq(big.value.length, rep.limits.maxValChars, 'D: 記録本文は上限文字数まで');
    var bin = d.components[0].params[1].calls[0];
    eq(bin.omitted, 'binaryish', 'D: バイナリ値は本文を省略');
    ok(bin.value === undefined, 'D: バイナリ値の本文は記録しない');

    // ---- needle 集計 ----
    ok(rep.needle.hitCount >= 1, 'needle: 検出件数 >= 1');
    eq(rep.needle.value, NEEDLE, 'needle: 探索文字列を記録');
    var hitWheres = rep.needle.hits.map(function (h) { return h.where; }).join(' | ');
    ok(hitWheres.indexOf('AE.ADBE Text') !== -1, 'needle: どの component で見つかったか分かる  (' + hitWheres + ')');

    // ---- エラー総数 ----
    eq(rep.errors.length, 0, 'レポート: 走査自体の致命エラーは無し（値エラーはクリップ側に記録）');
})();

// ---------------------------------------------------------------- 4. meta モード（高速・安全）
(function testMetaMode() {
    written = {};
    var comp = mkComponent('AE.ADBE Text', 'グラフィック', [
        mkParam('Source Text', 'ソーステキスト', function () { throw new Error('meta では呼ばれないはず'); })
    ]);
    var seq = mkSeq([mkTrack('V1', [mkClip('X', 0, 1, [comp])])]);
    var D = load({ project: { activeSequence: seq } });
    var sum = jp(D.kmDiagRun('/tmp/mock-desktop/meta.json', '', 0, 'meta'), 'kmDiagRun戻り値');
    eq(sum.ok, 1, 'meta: 実行成功');
    var rep = jp(written['/tmp/mock-desktop/meta.json'], 'レポートJSON');
    eq(rep.valueMode, 'meta', 'meta: valueMode 記録');
    var p = rep.tracks[0].clips[0].components[0].params[0];
    eq(p.valueMode, 'meta', 'meta: param は値を読まない');
    ok(p.calls === undefined, 'meta: calls を出さない（値取得を試みない）');
    eq(p.displayName, 'ソーステキスト', 'meta: 名前は取れる');
})();

// ---------------------------------------------------------------- 5. maxClips 上限
(function testMaxClips() {
    written = {};
    var clips = [];
    for (var i = 0; i < 10; i++) { clips.push(mkClip('C' + i, i, i + 1, [])); }
    var seq = mkSeq([mkTrack('V1', clips)]);
    var D = load({ project: { activeSequence: seq } });
    var sum = jp(D.kmDiagRun('/tmp/mock-desktop/cap.json', '', 3, 'full'), 'kmDiagRun戻り値');
    eq(sum.totalClips, 10, 'maxClips: 総数は10と報告');
    eq(sum.scannedClips, 3, 'maxClips: 走査は3件で打ち切り');
    var rep = jp(written['/tmp/mock-desktop/cap.json'], 'レポートJSON');
    eq(rep.tracks[0].clips.length, 3, 'maxClips: レポートも3件');
})();

// ---------------------------------------------------------------- 6. 名前に needle があるケース（クリップ名＝本文の誤認防止）
(function testNeedleInClipName() {
    written = {};
    var seq = mkSeq([mkTrack('V1', [mkClip(NEEDLE, 0, 1, [])])]);
    var D = load({ project: { activeSequence: seq } });
    D.kmDiagRun('/tmp/mock-desktop/name.json', NEEDLE, 0, 'full');
    var rep = jp(written['/tmp/mock-desktop/name.json'], 'レポートJSON');
    eq(rep.needle.hitCount >= 1, true, 'クリップ名 needle: 検出');
    var w = rep.needle.hits.map(function (h) { return h.where; }).join(' | ');
    ok(w.indexOf('trackItem.name') !== -1, 'クリップ名 needle: trackItem.name として報告される  (' + w + ')');
})();

// ---------------------------------------------------------------- 7. 出力パス自動命名
(function testAutoPath() {
    written = {};
    var seq = mkSeq([mkTrack('V1', [])]);
    var D = load({ project: { activeSequence: seq } });
    var sum = jp(D.kmDiagRun('', '', 0, 'full'), 'kmDiagRun戻り値');
    ok(/^\/tmp\/mock-desktop\/KoseiMarker-textdiag-\d{8}-\d{6}\.json$/.test(sum.path),
        '自動命名: デスクトップ配下にタイムスタンプ付きで作る  (' + sum.path + ')');
})();

// ---------------------------------------------------------------- 8. getParamForDisplayName が無い環境
(function testNoGetParamForDisplayName() {
    written = {};
    var comp = mkComponent('AE.ADBE Text', 'G', [
        mkParam('Source Text', 'Source Text', function () { return 'ok'; })
    ], { noGetParamForDisplayName: true });
    var seq = mkSeq([mkTrack('V1', [mkClip('X', 0, 1, [comp])])]);
    var D = load({ project: { activeSequence: seq } });
    D.kmDiagRun('/tmp/mock-desktop/nogp.json', '', 0, 'full');
    var rep = jp(written['/tmp/mock-desktop/nogp.json'], 'レポートJSON');
    var bd = rep.tracks[0].clips[0].components[0].byDisplayName[0];
    eq(bd.available, false, 'getParamForDisplayName 無し: available=false で記録');
    eq(bd.error, 'getParamForDisplayName が存在しない', 'getParamForDisplayName 無し: 理由を明示');
    // 素の index 走査は成功している＝名前APIが無くても取れることを示す
    eq(rep.tracks[0].clips[0].components[0].params[0].calls[0].value, 'ok', 'index走査は成功する');
})();

// ---------------------------------------------------------------- 結果
if (fail === 0) { console.log('TEXTDIAG ALL PASS (' + pass + ' assertions)'); }
else { console.error('TEXTDIAG FAILED: ' + fail + ' / total ' + (pass + fail)); process.exit(1); }
