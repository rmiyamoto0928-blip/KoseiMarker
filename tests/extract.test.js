// node tests/extract.test.js で実行
// diag/extract.js（診断JSON → 本文抽出／Adobe CSV 比較）の回帰テスト。
// 実機データが無い段階でも「抽出ロジックと比較ロジックが正しいか」はここで確かめられる。
'use strict';
var X = require('../diag/extract.js');

var pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; } else { fail++; console.error('FAIL: ' + label); } }
function eq(a, b, label) { ok(a === b, label + '  (actual=' + JSON.stringify(a) + ' expected=' + JSON.stringify(b) + ')'); }
function deq(a, b, label) { eq(JSON.stringify(a), JSON.stringify(b), label); }

// ---------------------------------------------------------------- 正規化
(function testNormalize() {
    eq(X.normalizeForCompare('  お問い合わせ　はこちら '), 'お問い合わせ はこちら', '正規化: 全角空白→半角・前後trim');
    eq(X.normalizeForCompare('a\r\nb'), 'a b', '正規化: 既定では改行も空白に畳む');
    eq(X.normalizeForCompare('a\r\nb', { keepNewlines: true }), 'a\nb', '正規化: keepNewlines で改行を保持');
    eq(X.normalizeForCompare('a \n  b', { keepNewlines: true }), 'a\nb', '正規化: 改行前後の空白を落とす');
    eq(X.normalizeForCompare('​‌⁠テキスト'), 'テキスト', '正規化: ゼロ幅文字を除去（校正マーカーIDタグ対策）');
    // NFD 濁点分解（macOS のファイル名等）を NFC に寄せる
    eq(X.normalizeForCompare('ガ'), 'ガ', '正規化: NFD濁点を NFC に統一');
})();

// ---------------------------------------------------------------- 本文らしさ判定
(function testRejectReason() {
    eq(X.rejectReason('お問い合わせはこちら'), null, 'reject: 普通の本文は通す');
    eq(X.rejectReason('5段以上、または1m以上'), null, 'reject: 数字混じりの本文は通す');
    ok(X.rejectReason('') !== null, 'reject: 空文字は落とす');
    ok(X.rejectReason('   ') !== null, 'reject: 空白のみは落とす');
    ok(X.rejectReason('AE.ADBE Text') !== null, 'reject: matchName は落とす');
    ok(X.rejectReason('123.45') !== null, 'reject: 数値のみは落とす');
    ok(X.rejectReason('true') !== null, 'reject: 真偽値は落とす');
    ok(X.rejectReason('960, 540') !== null, 'reject: 座標らしい数値列は落とす');
    eq(X.rejectReason('2026年'), null, 'reject: 年号は本文として通す');
})();

// ---------------------------------------------------------------- CSV パーサ（RFC4180）
(function testParseCsv() {
    var r = X.parseCsv('a,b,c\n1,2,3\n');
    deq(r.rows, [['a', 'b', 'c'], ['1', '2', '3']], 'CSV: 単純な表');

    r = X.parseCsv('"a,1","b\nc","d""e"\n');
    deq(r.rows, [['a,1', 'b\nc', 'd"e']], 'CSV: 引用符内のカンマ/改行/二重引用符');

    r = X.parseCsv('﻿a,b\r\n1,2\r\n');
    deq(r.rows, [['a', 'b'], ['1', '2']], 'CSV: BOM と CRLF');

    r = X.parseCsv('a,b\n1,2');
    deq(r.rows, [['a', 'b'], ['1', '2']], 'CSV: 末尾改行なし');

    r = X.parseCsv('a,b\n\n1,2\n');
    deq(r.rows, [['a', 'b'], ['1', '2']], 'CSV: 空行は無視');

    r = X.parseCsv('"閉じてない,x\n');
    eq(r.unterminatedQuote, true, 'CSV: 閉じていない引用符を検出');
})();

// ---------------------------------------------------------------- Adobe CSV 読み取り
(function testParseAdobeCsv() {
    // 英語ヘッダ（Adobe の既定列）
    var en = 'Start Time,End Time,Text,Video Track,Layer ID\n' +
             '00:00:05:10,00:00:08:00,"これから向かう現場は",V2,1\n' +
             '00:00:26:20,00:00:29:00,"5段または1m以上",V2,2\n';
    var a = X.parseAdobeCsv(en);
    eq(a.headerDetected, true, 'AdobeCSV: 英語ヘッダを検出');
    eq(a.rows.length, 2, 'AdobeCSV: 2件');
    eq(a.rows[0].text, 'これから向かう現場は', 'AdobeCSV: 本文');
    eq(a.rows[0].start, '00:00:05:10', 'AdobeCSV: 開始TC');
    eq(a.rows[0].end, '00:00:08:00', 'AdobeCSV: 終了TC');
    eq(a.rows[0].track, 'V2', 'AdobeCSV: トラック');
    eq(a.rows[1].layer, '2', 'AdobeCSV: レイヤーID');
    eq(a.warnings.length, 0, 'AdobeCSV: 警告なし');

    // 日本語ヘッダ（日本語UIでの書き出し）
    var ja = '開始時間,終了時間,テキスト,ビデオトラック,レイヤー ID\n' +
             '00:00:01:00,00:00:02:00,"日本語ヘッダのテスト",V1,1\n';
    var b = X.parseAdobeCsv(ja);
    eq(b.headerDetected, true, 'AdobeCSV: 日本語ヘッダを検出');
    eq(b.rows[0].text, '日本語ヘッダのテスト', 'AdobeCSV: 日本語ヘッダでも本文が取れる');

    // ヘッダ無し → 列順フォールバック
    var noHdr = '00:00:01:00,00:00:02:00,ヘッダ無し本文,V1,1\n';
    var c = X.parseAdobeCsv(noHdr);
    eq(c.headerDetected, false, 'AdobeCSV: ヘッダ無しを検出');
    eq(c.rows[0].text, 'ヘッダ無し本文', 'AdobeCSV: 列順フォールバックで本文が取れる');
    ok(c.warnings.length > 0, 'AdobeCSV: フォールバックを警告として残す');

    // 改行を含む本文
    var multi = 'Start Time,End Time,Text,Video Track,Layer ID\n' +
                '00:00:01:00,00:00:02:00,"1行目\n2行目",V1,1\n';
    var d = X.parseAdobeCsv(multi);
    eq(d.rows.length, 1, 'AdobeCSV: 改行入り本文でも1件として読む');
    eq(d.rows[0].text, '1行目\n2行目', 'AdobeCSV: 改行を保持');

    // 本文が空の行はスキップ
    var empty = 'Start Time,End Time,Text,Video Track,Layer ID\n' +
                '00:00:01:00,00:00:02:00,,V1,1\n' +
                '00:00:03:00,00:00:04:00,ある,V1,2\n';
    var e = X.parseAdobeCsv(empty);
    eq(e.rows.length, 1, 'AdobeCSV: 本文が空の行は数えない');
    eq(e.rows[0].text, 'ある', 'AdobeCSV: 残った行が正しい');

    eq(X.parseAdobeCsv('').rows.length, 0, 'AdobeCSV: 空入力で0件');
})();

// ---------------------------------------------------------------- 診断JSON → 抽出
function mkCall(name, extra) {
    var o = { call: name, ok: true };
    for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { o[k] = extra[k]; } }
    return o;
}
function mkStrCall(name, value, extra) {
    var o = mkCall(name, extra);
    o.type = 'string'; o.value = value; o.len = value.length;
    if (o.looksJson === undefined) { o.looksJson = false; }
    return o;
}
function mkParamNode(index, displayName, calls) {
    return { index: index, name: displayName, displayName: displayName, calls: calls };
}
function mkCompNode(matchName, displayName, params, byDisplayName) {
    return {
        index: 0, matchName: matchName, displayName: displayName,
        paramCount: params.length, params: params,
        byDisplayName: byDisplayName || []
    };
}
function mkClipNode(opts) {
    return {
        trackIndex: opts.trackIndex || 0,
        clipIndex: opts.clipIndex || 0,
        name: opts.name || 'clip',
        matchName: mkStrCall('getMatchName()', opts.matchName || 'AE.ADBE Text'),
        disabled: mkCall('disabled', { type: 'boolean', value: !!opts.disabled }),
        start: { ticks: '254016000000', seconds: opts.startSeconds === undefined ? 1 : opts.startSeconds },
        end: { ticks: '762048000000', seconds: opts.endSeconds === undefined ? 3 : opts.endSeconds },
        projectItem: {
            name: mkStrCall('projectItem.name', opts.projectItemName || 'PI'),
            isSequence: mkCall('projectItem.isSequence()', { type: 'boolean', value: !!opts.nested })
        },
        mgt: opts.mgt || { available: true, component: null },
        componentCount: (opts.components || []).length,
        components: opts.components || []
    };
}
function mkReport(clipNodes, extra) {
    var rep = {
        schema: 'koseimarker.textdiag/1',
        valueMode: 'full',
        host: { locale: mkStrCall('$.locale', 'ja_JP'), appVersion: mkStrCall('app.version', '26.5.0') },
        sequence: {
            name: mkStrCall('seq.name', '案件A'),
            sequenceID: mkStrCall('seq.sequenceID', 'GUID-1'),
            timebase: mkStrCall('seq.timebase', '8467200'),
            zeroPoint: mkStrCall('seq.zeroPoint', '0'),
            videoDisplayFormat: mkCall('seq.videoDisplayFormat', { type: 'number', value: 110 }),
            fps: 30
        },
        limits: { maxValChars: 4000 },
        tracks: [{ trackIndex: 0, label: 'V1', clipCount: clipNodes.length, clips: clipNodes }],
        needle: { value: '', hitCount: 0, hits: [] },
        stats: { videoTrackCount: 1, totalClips: clipNodes.length, scannedClips: clipNodes.length },
        errors: [],
        truncated: false
    };
    for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { rep[k] = extra[k]; } }
    return rep;
}

(function testExtractSchemaGuard() {
    var r = X.extract({ schema: 'something/else' });
    ok(!!r.error, '抽出: schema が違えばエラーを返す');
    ok(!!X.extract(null).error, '抽出: null でエラーを返す');
})();

(function testExtractPlainString() {
    // AE MOGRT 風: 本文が素の string
    var mgtComp = mkCompNode('AE.ADBE MGT', 'Motion Graphics Template', [
        mkParamNode(0, 'Source Text', [mkStrCall('getValue()', 'お問い合わせはこちら')]),
        mkParamNode(1, 'Color', [mkCall('getValue()', { type: 'object', arrayLike: true, array: [255, 0, 0, 255] })])
    ]);
    var rep = mkReport([mkClipNode({
        name: 'MOGRT_A', mgt: { available: true, component: mgtComp }, components: []
    })]);
    var out = X.extract(rep);
    eq(out.schema, 'koseimarker.graphics/1', '抽出: 出力 schema');
    eq(out.sequence.name, '案件A', '抽出: シーケンス名');
    eq(out.sequence.fps, 30, '抽出: fps');
    eq(out.graphics.length, 1, '抽出: グラフィック1件');
    eq(out.graphics[0].type, 'mogrt', '抽出: MOGRT と分類');
    eq(out.graphics[0].texts.length, 1, '抽出: 本文1件');
    eq(out.graphics[0].texts[0].text, 'お問い合わせはこちら', '抽出: 本文');
    eq(out.graphics[0].texts[0].confidence, 'high', '抽出: 素の string は high');
    eq(out.graphics[0].texts[0].componentMatchName, 'AE.ADBE MGT', '抽出: 由来 component を記録');
    eq(out.diagnostics.textCount, 1, '抽出: textCount');
    eq(out.diagnostics.hostLocale, 'ja_JP', '抽出: ロケールを引き継ぐ');
    // 色（配列）は本文にしない
    var rejReasons = out.rejected.map(function (r) { return r.reason; }).join(' | ');
    ok(rejReasons.indexOf('型が string でない') !== -1, '抽出: 非string param を理由付きで除外  (' + rejReasons + ')');
})();

(function testExtractJsonSourceText() {
    // Premiere ネイティブグラフィック風: Source Text が JSON 文字列
    var p = mkParamNode(3, 'ソーステキスト', [
        mkStrCall('getValue()', '{"mTextParam":{"textEditValue":"5段以上、または1m以上","fontTextRunLength":12}}', {
            looksJson: true,
            jsonTextKeys: [{ key: 'textEditValue', value: '5段以上、または1m以上', truncated: false }]
        })
    ]);
    var comp = mkCompNode('AE.ADBE Text', 'グラフィック', [p]);
    var rep = mkReport([mkClipNode({ name: 'テロップB', components: [comp] })]);
    var out = X.extract(rep);
    eq(out.graphics.length, 1, 'JSON本文: 1件');
    eq(out.graphics[0].type, 'premiereGraphic', 'JSON本文: premiereGraphic と分類');
    eq(out.graphics[0].texts[0].text, '5段以上、または1m以上', 'JSON本文: textEditValue を採用');
    eq(out.graphics[0].texts[0].confidence, 'high', 'JSON本文: 既知キーは high');
    ok(out.graphics[0].texts[0].via.indexOf('textEditValue') !== -1, 'JSON本文: via に採用キーを残す');
})();

(function testExtractKeyPriority() {
    // 複数の text 系キーがある場合は優先度順（textEditValue > mRawText > 未知キー）
    var p = mkParamNode(0, 'Source Text', [
        mkStrCall('getValue()', '{...}', {
            looksJson: true,
            jsonTextKeys: [
                { key: 'someUnknownTextThing', value: 'ダミー', truncated: false },
                { key: 'mRawText', value: '生テキスト', truncated: false },
                { key: 'textEditValue', value: '本命テキスト', truncated: false }
            ]
        })
    ]);
    var rep = mkReport([mkClipNode({ components: [mkCompNode('AE.ADBE Text', 'G', [p])] })]);
    var out = X.extract(rep);
    eq(out.graphics[0].texts[0].text, '本命テキスト', 'キー優先度: textEditValue が最優先');
    eq(out.graphics[0].texts.length, 3, 'キー優先度: 他の候補も捨てずに残す');
    eq(out.graphics[0].texts[1].text, '生テキスト', 'キー優先度: 2番目は mRawText');
    eq(out.graphics[0].texts[2].confidence, 'medium', 'キー優先度: 未知キーは medium');
    // 件数を数えるのは primary だけ（同一paramの別キーで一致率が水増しされないように）
    deq(out.graphics[0].texts.map(function (t) { return t.primary; }), [true, false, false],
        'キー優先度: 先頭のみ primary');

    // primaryOnly（既定）では1件として数える
    var csv = 'Start Time,End Time,Text,Video Track,Layer ID\n00:00:01:00,00:00:02:00,本命テキスト,V1,1\n';
    var a = X.parseAdobeCsv(csv);
    var r = X.compare(out, a);
    eq(r.extractCount, 1, 'primaryOnly: 同一paramの副候補は数えない');
    eq(r.exactMatches, 1, 'primaryOnly: 完全一致1件');
    eq(r.extraCount, 0, 'primaryOnly: 余分0（副候補が余分にならない）');
    eq(r.coveragePercent, 100, 'primaryOnly: 一致率100%');
    // primaryOnly=false なら全候補を数える（調査用）
    var rAll = X.compare(out, a, { primaryOnly: false });
    eq(rAll.extractCount, 3, 'primaryOnly=false: 全候補を数える');
    eq(rAll.extraCount, 2, 'primaryOnly=false: 副候補は余分として現れる');
})();

(function testPrimaryFlagOnPlainString() {
    var comp = mkCompNode('AE.ADBE Text', 'G', [
        mkParamNode(0, 'Source Text', [mkStrCall('getValue()', '単一本文')])
    ]);
    var out = X.extract(mkReport([mkClipNode({ components: [comp] })]));
    eq(out.graphics[0].texts[0].primary, true, 'primary: 素の string でも primary が立つ');
})();

(function testExtractMultipleTextsPerGraphic() {
    // 同一Graphic内に複数の編集可能テキスト（STEP5 M）
    var comp = mkCompNode('AE.ADBE Text', 'グラフィック', [
        mkParamNode(0, 'メインテロップ', [mkStrCall('getValue()', '上段テキスト')]),
        mkParamNode(1, 'サブテロップ', [mkStrCall('getValue()', '下段テキスト')])
    ]);
    var rep = mkReport([mkClipNode({ components: [comp] })]);
    var out = X.extract(rep);
    eq(out.graphics[0].texts.length, 2, '複数テキスト: 2件とも取れる');
    eq(out.graphics[0].texts[0].paramDisplayName, 'メインテロップ', '複数テキスト: レイヤー名を保持');
    eq(out.graphics[0].texts[1].text, '下段テキスト', '複数テキスト: 2件目の本文');
})();

(function testExtractDedupe() {
    // index走査 と getParamForDisplayName の両方で同じ本文が出ても1件に畳む
    var p = mkParamNode(0, 'Source Text', [mkStrCall('getValue()', '重複する本文')]);
    var comp = mkCompNode('AE.ADBE Text', 'G', [p], [
        { displayName: 'Source Text', available: true, found: true, param: p }
    ]);
    var rep = mkReport([mkClipNode({ components: [comp] })]);
    var out = X.extract(rep);
    eq(out.graphics[0].texts.length, 1, '重複除去: 1件に畳む');
    ok(!!out.graphics[0].texts[0].alsoVia, '重複除去: もう一方の経路も記録して残す');
})();

(function testExtractErrorsAndFlags() {
    // 呼び出し失敗・省略・無効クリップ・ネストを取りこぼさず記録する
    var failComp = mkCompNode('AE.ADBE Text', 'G', [
        { index: 0, name: 'Source Text', displayName: 'Source Text', calls: [{ call: 'getValue()', ok: false, error: '値取得に失敗' }] }
    ]);
    var binComp = mkCompNode('AE.ADBE Bin', 'B', [
        { index: 0, name: 'Blob', displayName: 'Blob', calls: [{ call: 'getValue()', ok: true, type: 'string', len: 99, omitted: 'binaryish' }] }
    ]);
    var okComp = mkCompNode('AE.ADBE Text', 'G', [
        mkParamNode(0, 'Source Text', [mkStrCall('getValue()', '無効クリップの本文')])
    ]);
    var rep = mkReport([
        mkClipNode({ clipIndex: 0, name: '失敗クリップ', components: [failComp], startSeconds: 1 }),
        mkClipNode({ clipIndex: 1, name: 'バイナリクリップ', components: [binComp], startSeconds: 2 }),
        mkClipNode({ clipIndex: 2, name: '無効ネストクリップ', components: [okComp], disabled: true, nested: true, startSeconds: 3 })
    ]);
    var out = X.extract(rep);
    eq(out.graphics.length, 1, 'フラグ: 本文が取れたのは1件');
    eq(out.graphics[0].disabled, true, 'フラグ: 無効クリップを記録');
    eq(out.graphics[0].isNestedSequence, true, 'フラグ: ネストを記録');
    eq(out.diagnostics.disabledClipsWithText, 1, 'フラグ: 無効クリップ件数');
    eq(out.diagnostics.nestedSequenceClips, 1, 'フラグ: ネスト件数');
    var reasons = out.rejected.map(function (r) { return r.reason; });
    ok(reasons.join(' | ').indexOf('呼び出し失敗: 値取得に失敗') !== -1, 'フラグ: 呼び出し失敗を理由付きで残す');
    ok(reasons.join(' | ').indexOf('省略(binaryish)') !== -1, 'フラグ: バイナリ省略を理由付きで残す');
})();

(function testExtractSortOrder() {
    var mk = function (ci, sec, text) {
        return mkClipNode({
            clipIndex: ci, startSeconds: sec,
            components: [mkCompNode('AE.ADBE Text', 'G', [mkParamNode(0, 'Source Text', [mkStrCall('getValue()', text)])])]
        });
    };
    var out = X.extract(mkReport([mk(0, 9, '後'), mk(1, 2, '先'), mk(2, 5, '中')]));
    deq(out.graphics.map(function (g) { return g.texts[0].text; }), ['先', '中', '後'], '並び: 開始時間順');
})();

(function testExtractTruncationPropagates() {
    var rep = mkReport([], { truncated: true, errors: ['"V1 clip[3]: 取得失敗"'] });
    var out = X.extract(rep);
    eq(out.diagnostics.truncated, true, '打ち切り: diagnostics に伝わる');
    eq(out.diagnostics.errors.length, 1, '打ち切り: errors を引き継ぐ');
})();

// ---------------------------------------------------------------- 比較（STEP6）
function extractedOf(texts) {
    return {
        schema: 'koseimarker.graphics/1',
        graphics: texts.map(function (t, i) {
            return {
                trackIndex: 1, trackLabel: 'V2', clipIndex: i, clipName: 'c' + i,
                type: 'premiereGraphic', disabled: false, isNestedSequence: false,
                start: { ticks: '0', seconds: i }, end: { ticks: '0', seconds: i + 1 },
                texts: [{ text: t, via: 'getValue()', confidence: 'high' }]
            };
        })
    };
}

(function testCompareExact() {
    var csv = 'Start Time,End Time,Text,Video Track,Layer ID\n' +
              '00:00:01:00,00:00:02:00,"これから向かう現場は",V2,1\n' +
              '00:00:03:00,00:00:04:00,"5段または1m以上",V2,2\n';
    var a = X.parseAdobeCsv(csv);
    var r = X.compare(extractedOf(['これから向かう現場は', '5段または1m以上']), a);
    eq(r.adobeCount, 2, '比較: Adobe件数');
    eq(r.extractCount, 2, '比較: 抽出件数');
    eq(r.exactMatches, 2, '比較: 完全一致');
    eq(r.missingCount, 0, '比較: 取得漏れ0');
    eq(r.extraCount, 0, '比較: 余分0');
    eq(r.coveragePercent, 100, '比較: 一致率100%');
})();

(function testCompareMissingAndExtra() {
    var csv = 'Start Time,End Time,Text,Video Track,Layer ID\n' +
              '00:00:01:00,00:00:02:00,"取れる本文",V2,1\n' +
              '00:00:03:00,00:00:04:00,"取れない本文",V2,2\n' +
              '00:00:05:00,00:00:06:00,"これも取れない",V2,3\n';
    var a = X.parseAdobeCsv(csv);
    var r = X.compare(extractedOf(['取れる本文', '余分な本文']), a);
    eq(r.adobeCount, 3, '比較(漏れ): Adobe件数');
    eq(r.exactMatches, 1, '比較(漏れ): 一致1件');
    eq(r.missingCount, 2, '比較(漏れ): 取得漏れ2件');
    eq(r.extraCount, 1, '比較(漏れ): 余分1件');
    eq(r.coveragePercent, 33.33, '比較(漏れ): 一致率33.33%');
    deq(r.missing.map(function (m) { return m.text; }), ['取れない本文', 'これも取れない'], '比較(漏れ): 漏れた本文を列挙');
    eq(r.extra[0].text, '余分な本文', '比較(漏れ): 余分な本文を列挙');
})();

(function testCompareDuplicatesAsMultiset() {
    // 同じ本文が複数ある場合は件数まで合わせる（多重集合）
    var csv = 'Start Time,End Time,Text,Video Track,Layer ID\n' +
              '00:00:01:00,00:00:02:00,"同じ本文",V2,1\n' +
              '00:00:03:00,00:00:04:00,"同じ本文",V2,2\n' +
              '00:00:05:00,00:00:06:00,"同じ本文",V2,3\n';
    var a = X.parseAdobeCsv(csv);
    var r = X.compare(extractedOf(['同じ本文', '同じ本文']), a);
    eq(r.adobeCount, 3, '多重集合: Adobe 3件');
    eq(r.exactMatches, 2, '多重集合: 一致は2件まで');
    eq(r.missingCount, 1, '多重集合: 1件は漏れ扱い');
    eq(r.extraCount, 0, '多重集合: 余分は0');
})();

(function testCompareNewlineSensitivity() {
    var csv = 'Start Time,End Time,Text,Video Track,Layer ID\n' +
              '00:00:01:00,00:00:02:00,"1行目\n2行目",V2,1\n';
    var a = X.parseAdobeCsv(csv);
    // 改行を見る（既定）: 改行が空白に化けていると不一致になる
    var strict = X.compare(extractedOf(['1行目 2行目']), a);
    eq(strict.exactMatches, 0, '改行: 既定では改行の違いを不一致として検出');
    eq(strict.compareOptions.keepNewlines, true, '改行: 既定は keepNewlines=true');
    // 改行を無視すると一致する＝「改行だけが違う」と切り分けられる
    var loose = X.compare(extractedOf(['1行目 2行目']), a, { keepNewlines: false });
    eq(loose.exactMatches, 1, '改行: keepNewlines=false なら一致（差分が改行だけと分かる）');
    // 改行が合っていれば厳密でも一致
    eq(X.compare(extractedOf(['1行目\n2行目']), a).exactMatches, 1, '改行: 改行が一致すれば厳密でも一致');
})();

(function testCompareEdgeCases() {
    var empty = X.parseAdobeCsv('Start Time,End Time,Text,Video Track,Layer ID\n');
    var r = X.compare(extractedOf([]), empty);
    eq(r.adobeCount, 0, '端: Adobe 0件');
    eq(r.coveragePercent, 100, '端: 両方0件なら100%（比較対象なし）');
    var r2 = X.compare(extractedOf(['余分だけ']), empty);
    eq(r2.coveragePercent, 0, '端: Adobe 0件で抽出だけ有るなら0%');
    eq(r2.extraCount, 1, '端: 余分1件');
    // 警告が引き継がれる
    var noHdr = X.parseAdobeCsv('00:00:01:00,00:00:02:00,本文,V1,1\n');
    ok(X.compare(extractedOf(['本文']), noHdr).warnings.length > 0, '端: CSV警告を比較結果に引き継ぐ');
})();

(function testCompareWhitespaceTolerance() {
    var csv = 'Start Time,End Time,Text,Video Track,Layer ID\n' +
              '00:00:01:00,00:00:02:00,"  お問い合わせ　はこちら  ",V2,1\n';
    var a = X.parseAdobeCsv(csv);
    eq(X.compare(extractedOf(['お問い合わせ はこちら']), a).exactMatches, 1,
        '空白差: 全角/前後空白の差は一致扱い');
})();

// ---------------------------------------------------------------- 結果
if (fail === 0) { console.log('EXTRACT ALL PASS (' + pass + ' assertions)'); }
else { console.error('EXTRACT FAILED: ' + fail + ' / total ' + (pass + fail)); process.exit(1); }
