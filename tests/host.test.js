// node tests/host.test.js で実行
// hostscript.jsx（ExtendScript）を node 上で擬似実行し、Premiere の marker API をモックして
// K4-1（ID定着検証）/ K4-2（identity除外・runId衝突）/ K4-3（listMarkers seqId同梱）/ K4-5（payloadフィールド数）を検証する。
// hostscript.jsx はトップレベルで app を参照しないため、Function に body を渡し app を引数注入して関数群を取り出す。
'use strict';
var fs = require('fs');
var path = require('path');

var pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; } else { fail++; console.error('FAIL: ' + label); } }
function eq(a, b, label) { ok(a === b, label + '  (actual=' + a + ' expected=' + b + ')'); }

var TICKS = 254016000000; // ticks/sec
var ZW = /[​‌⁠]/g;

// hostscript.jsx をロードして関数群を取り出す（app は可変オブジェクトを注入し、テストごとに activeSequence を差し替える）
var hostSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'hostscript.jsx'), 'utf8');
var appBox = { project: { activeSequence: null } };
var factory = new Function('app',
    hostSrc + '\n;return { replaceMarkers: replaceMarkers, listMarkers: listMarkers, ' +
    '_decodeId: _decodeId, _encodeId: _encodeId, _makeRid: _makeRid };');
var H = factory(appBox);

// ---- モック marker / sequence ----
// createMarker(sec) は指定秒（=フレーム境界）に marker を作り、start.ticks を frame*tpf で返す。
function makeMarker(sec, stripZW) {
    var _name = '';
    var mk = {
        comments: '',
        start: { seconds: sec, ticks: String(Math.round(sec * TICKS)) },
        setColorByIndex: function () { return; }
    };
    if (stripZW) {
        // K4-1 検証用: Premiere が名前から不可視文字を落とす環境を再現
        Object.defineProperty(mk, 'name', {
            get: function () { return _name; },
            set: function (v) { _name = String(v).replace(ZW, ''); },
            enumerable: true, configurable: true
        });
    } else {
        mk.name = '';
    }
    return mk;
}

function makeSeq(seqId, nominalFps, stripZW) {
    var tpf = TICKS / nominalFps; // ticks per frame（timebase）
    var arr = [];
    var seq = {
        name: 'MockSeq',
        sequenceID: seqId,
        timebase: String(tpf),
        zeroPoint: '0',
        videoDisplayFormat: '110',
        getSettings: function () { return { videoFrameRate: { ticks: String(tpf) } }; },
        markers: {
            _arr: arr,
            getFirstMarker: function () { return arr.length ? arr[0] : null; },
            getNextMarker: function (m) { var i = arr.indexOf(m); return (i >= 0 && i + 1 < arr.length) ? arr[i + 1] : null; },
            createMarker: function (sec) { var mk = makeMarker(sec, stripZW); arr.push(mk); return mk; },
            deleteMarker: function (m) { var i = arr.indexOf(m); if (i >= 0) { arr.splice(i, 1); } }
        }
    };
    return seq;
}

// 既存（旧）所有マーカーを直接仕込む（createMarker を経ずに name をそのまま持たせる）
function seedOwned(seq, frame, runId, k, nameText) {
    var tpf = TICKS / 30; // seed 用 30fps 固定（seq と一致させる呼び出しにする）
    return _seedOwned(seq, frame, runId, k, nameText);
}
function _seedOwned(seq, frame, runId, k, nameText) {
    var tpf = parseFloat(seq.timebase);
    var sec = frame * tpf / TICKS;
    var mk = { name: (nameText || '校正 old') + H._encodeId(runId, k), comments: '', start: { seconds: sec, ticks: String(Math.round(frame * tpf)) }, setColorByIndex: function () { return; } };
    seq.markers._arr.push(mk);
    return mk;
}

var F1 = String.fromCharCode(1), F2 = String.fromCharCode(2), F3 = String.fromCharCode(3);
function rec(frame, name, comment, runId, k) { return frame + F1 + name + F1 + comment + F1 + runId + F1 + k; }
function ownedCount(seq) { var n = 0, a = seq.markers._arr; for (var i = 0; i < a.length; i++) { if (H._decodeId(a[i].name) !== null) { n++; } } return n; }

// ===== K4-5: payload フィールド数の厳密化（!==5 で中止） =====
(function () {
    var seq = makeSeq('SID-1', 30, false); appBox.project.activeSequence = seq;
    // 余分フィールド（6個）→ 中止・追加0
    var res = H.replaceMarkers(rec(10, '校正 A', 'c', 1000, 0) + F1 + 'extra', 'SID-1', '0');
    ok(res.indexOf('"error"') !== -1, 'K4-5: 余分フィールドのpayloadは中止（error）');
    eq(seq.markers._arr.length, 0, 'K4-5: 余分フィールド時はマーカーを追加しない');

    // フィールド不足（4個）→ 中止
    var res2 = H.replaceMarkers('10' + F1 + '校正 A' + F1 + 'c' + F1 + '1000', 'SID-1', '0');
    ok(res2.indexOf('"error"') !== -1, 'K4-5: フィールド不足のpayloadは中止（error）');

    // ちょうど5フィールド → 正常追加
    var res3 = H.replaceMarkers(rec(10, '校正 A', 'c', 1000, 0), 'SID-1', '0');
    var d3 = JSON.parse(res3);
    eq(d3.added, 1, 'K4-5: 正規5フィールドは1件追加');
    eq(d3.failed, 0, 'K4-5: 正規5フィールドは失敗0');
})();

// ===== K4-1: ID定着検証（不可視IDが保持されない環境では追加失敗扱い＋旧削除を中止） =====
(function () {
    var seq = makeSeq('SID-1', 30, true); // stripZW=true でゼロ幅IDが名前から消える環境
    appBox.project.activeSequence = seq;
    // 旧所有マーカーを1件仕込む（clearFirst で消えてはいけない＝消失防止）
    _seedOwned(seq, 999, 5, 0, '校正 旧');
    var before = seq.markers._arr.length;

    var res = H.replaceMarkers(rec(10, '校正 A', 'c', 1000, 0), 'SID-1', '1'); // clearFirst=1
    var d = JSON.parse(res);
    eq(d.added, 0, 'K4-1: ID定着しない環境では added=0');
    eq(d.idVerifyFailed, 1, 'K4-1: idVerifyFailed=1');
    ok(d.failed >= 1, 'K4-1: failed>=1');
    eq(d.cleared, 0, 'K4-1: 追加失敗があるので旧削除を中止（cleared=0）');
    // 旧マーカーは保持され、定着失敗の新マーカーは削除されている＝配列は before と同数（旧1件のみ）
    eq(seq.markers._arr.length, before, 'K4-1: 旧マーカー保持・定着失敗の新マーカーは除去');
    ok(H._decodeId(seq.markers._arr[0].name) !== null, 'K4-1: 生き残ったのは旧所有マーカー');
})();

// ===== K4-2: runId 衝突しても identity（生name＋ticks）で今回分だけ残す =====
(function () {
    var seq = makeSeq('SID-1', 30, false);
    appBox.project.activeSequence = seq;
    // 旧マーカー: runId=1000,k=0（＝今回と同じ rid になる衝突ケース）を別フレーム(999)に仕込む
    _seedOwned(seq, 999, 1000, 0, '校正 旧衝突');
    // 今回: runId=1000,k=0 を frame=10 に追加、clearFirst=1
    var res = H.replaceMarkers(rec(10, '校正 新', 'c', 1000, 0), 'SID-1', '1');
    var d = JSON.parse(res);
    eq(d.added, 1, 'K4-2: 新マーカー1件追加');
    eq(d.failed, 0, 'K4-2: 失敗0');
    eq(d.cleared, 1, 'K4-2: rid衝突の旧マーカーは identity 差で削除される（cleared=1）');
    // 残るのは今回の新マーカー（frame=10）だけ
    eq(ownedCount(seq), 1, 'K4-2: 所有マーカーは今回分の1件のみ');
    var tpf = parseFloat(seq.timebase);
    eq(String(seq.markers._arr[0].start.ticks), String(10 * tpf), 'K4-2: 残ったのは frame=10 の新マーカー');

    // 対照: rid 一致除外だった旧実装なら旧(frame999)を「今回分」と誤認して残していた。identity では正しく消える。
})();

// ===== K4-2 対照: 衝突なしの通常 replace（旧削除＋新追加） =====
(function () {
    var seq = makeSeq('SID-1', 30, false);
    appBox.project.activeSequence = seq;
    _seedOwned(seq, 500, 7, 0, '校正 旧');   // 旧 run の別マーカー
    var res = H.replaceMarkers(rec(20, '校正 新', 'c', 2000, 0), 'SID-1', '1');
    var d = JSON.parse(res);
    eq(d.added, 1, 'K4-2対照: 新1件追加');
    eq(d.cleared, 1, 'K4-2対照: 旧1件削除');
    eq(ownedCount(seq), 1, 'K4-2対照: 残り所有1件（新のみ）');
})();

// ===== K5-1: 過去と今回追加が「生name＋ticks」完全一致でも、旧1件だけ消え今回1件が残る =====
// runId衝突(1000,0)＋本文一致(校正 A)＋同一フレーム(10)の三重偶然。集合(keepKeys)方式では両方保持=cleared=0だった。
// 追加前スナップショット(多重集合)方式なら、削除対象はスナップショット件数分(=旧1件)だけに限られる。
(function () {
    var seq = makeSeq('SID-1', 30, false);
    appBox.project.activeSequence = seq;
    // 旧マーカー: frame=10 / runId=1000,k=0 / name本文='校正 A' → 生name(IDタグ込み)＋ticks が今回追加と完全一致
    _seedOwned(seq, 10, 1000, 0, '校正 A');
    // 今回: 同じ frame=10 / runId=1000,k=0 / name='校正 A' を追加、clearFirst=1
    var res = H.replaceMarkers(rec(10, '校正 A', 'c', 1000, 0), 'SID-1', '1');
    var d = JSON.parse(res);
    eq(d.added, 1, 'K5-1: 新マーカー1件追加');
    eq(d.failed, 0, 'K5-1: 失敗0');
    eq(d.cleared, 1, 'K5-1: 生name＋ticks完全一致でも旧1件だけ削除される（cleared=1）');
    eq(ownedCount(seq), 1, 'K5-1: 残る所有マーカーは今回分の1件のみ（重複残存しない）');
})();

// ===== K5-1 対照: 同一キーが旧2件あれば、追加後も旧2件だけ消え今回1件が残る（多重集合の件数消費） =====
(function () {
    var seq = makeSeq('SID-1', 30, false);
    appBox.project.activeSequence = seq;
    _seedOwned(seq, 10, 1000, 0, '校正 A'); // 旧1
    _seedOwned(seq, 10, 1000, 0, '校正 A'); // 旧2（同一キー）
    var res = H.replaceMarkers(rec(10, '校正 A', 'c', 1000, 0), 'SID-1', '1');
    var d = JSON.parse(res);
    eq(d.added, 1, 'K5-1対照: 新1件追加');
    eq(d.cleared, 2, 'K5-1対照: 同一キー旧2件を件数分だけ削除（cleared=2）');
    eq(ownedCount(seq), 1, 'K5-1対照: 残るのは今回分1件（旧2件は消える）');
})();

// ===== K4-3: listMarkers が seqId を同梱して返す =====
(function () {
    var seq = makeSeq('SID-XYZ', 30, false);
    appBox.project.activeSequence = seq;
    H.replaceMarkers(rec(10, '校正 A', 'c1', 1000, 0) + F2 + rec(20, '校正 B', 'c2', 1000, 1), 'SID-XYZ', '0');
    var res = H.listMarkers();
    ok(res.charAt(0) !== '{', 'K4-3: 正常応答はJSONエラーでない');
    var sep = res.indexOf(F3);
    ok(sep !== -1, 'K4-3: 応答に F3 区切りがある');
    var seqId = res.slice(0, sep), body = res.slice(sep + 1);
    eq(seqId, 'SID-XYZ', 'K4-3: 応答先頭が対象シーケンスID');
    var recs = body.split(F2);
    eq(recs.length, 2, 'K4-3: 本体に2レコード');
    // 本体の各レコードは ticks/name/comment/secs の4フィールド
    eq(recs[0].split(F1).length, 4, 'K4-3: レコードは4フィールド');

    // マーカー無し時: seqId + F3 + 空本体
    var seq2 = makeSeq('SID-EMPTY', 30, false); appBox.project.activeSequence = seq2;
    var res2 = H.listMarkers();
    var sep2 = res2.indexOf(F3);
    eq(res2.slice(0, sep2), 'SID-EMPTY', 'K4-3: マーカー無しでも seqId を返す');
    eq(res2.slice(sep2 + 1), '', 'K4-3: マーカー無しは本体空');
})();

console.log(fail === 0 ? 'HOST ALL PASS (' + pass + ' assertions)' : pass + ' pass / ' + fail + ' FAIL');
process.exit(fail === 0 ? 0 : 1);
