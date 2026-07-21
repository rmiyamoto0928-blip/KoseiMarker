// ExtendScript host (Premiere Pro) ※ ExtendScript には JSON が無いので手組みで返す
// ES3制約: const/let/アロー/テンプレート文字列は使えない。var と function のみ。

// ---- ゼロ幅一意ID コーデック（K2-2/K3-4/K3-5/K3-6。js/parser.js の encodeId/decodeId と厳密に一致させること） ----
// この拡張が付けたマーカーを「完全不可視」に識別する。name 末尾にタグを付与:
//   FRAME + SIG + FRAME + runIdBits + FRAME + kBits + FRAME + checksumBits + FRAME
//   FRAME=U+2060(WORD JOINER) / 0bit=U+200B(ZWSP) / 1bit=U+200C(ZWNJ) … いずれも表示幅ゼロ。
// 所有判定は「センチネル構造＋名前空間シグネチャ一致＋チェックサム検証OK＋正準表現」を必須にする（K3-4）。形一致だけでは非所有。
// recordId は (runId, k) の2要素を別フィールドで符号化（K3-5: runId*1000+k の衝突を排除）。復号値は正準文字列 "runId:k"。
// 各数値は2進(MSB先頭・正準)で符号化。復号は乗算で行い 2^53 まで正確。
var KMID_ZERO = "\u200B";
var KMID_ONE = "\u200C";
var KMID_FRAME = "\u2060";

var KMID_SIG = "11001010111100001101"; // 名前空間シグネチャ（js/parser.js と厳密一致）
var KMID_CKP = 1000003;                 // チェックサム法（素数）

// 「空でない安全な非負整数」だけ受理し数値を返す。それ以外（空/符号/小数/非数字/2^53超）は null（K3-6）。
function _safeNonNegInt(s) {
    if (s === null || s === undefined) { return null; }
    var t = String(s);
    if (!/^[0-9]+$/.test(t)) { return null; }
    var n = parseInt(t, 10);
    if (!isFinite(n) || n < 0) { return null; }
    if (n > 9007199254740991) { return null; } // 2^53-1 超は非受理
    return n;
}

function _numToBits(n) {
    if (n === 0) { return "0"; }
    var bits = "", x = n;
    while (x > 0) { bits = (x % 2) + bits; x = Math.floor(x / 2); }
    return bits;
}
function _bitsToNum(bits) {
    var val = 0;
    for (var j = 0; j < bits.length; j++) { val = val * 2 + (bits.charAt(j) === "1" ? 1 : 0); }
    return val;
}
function _zwFromBits(bits) {
    var out = "";
    for (var i = 0; i < bits.length; i++) { out += (bits.charAt(i) === "1") ? KMID_ONE : KMID_ZERO; }
    return out;
}
function _zwToBits(part) {
    var b = "";
    for (var i = 0; i < part.length; i++) {
        var c = part.charAt(i);
        if (c === KMID_ZERO) { b += "0"; }
        else if (c === KMID_ONE) { b += "1"; }
        else { return null; }
    }
    return b;
}
function _isZW(ch) { return ch === KMID_ZERO || ch === KMID_ONE || ch === KMID_FRAME; }
function _nonCanonical(b) { return b.length > 1 && b.charAt(0) === "0"; }
function _checksum(runId, k) {
    var a = runId % KMID_CKP; if (a < 0) { a += KMID_CKP; }
    var b = k % KMID_CKP; if (b < 0) { b += KMID_CKP; }
    return (a * 31 + b * 17 + 12345) % KMID_CKP;
}
function _makeRid(runId, k) { return String(runId) + ":" + String(k); }

// (runId, k) をゼロ幅タグに符号化。不正値は例外（K3-6: 無限ループ・破損防止）。
function _encodeId(runId, k) {
    var r = _safeNonNegInt(runId), n = _safeNonNegInt(k);
    if (r === null || n === null) { throw new Error("encodeId: 不正なID"); }
    var cs = _checksum(r, n);
    return KMID_FRAME + _zwFromBits(KMID_SIG) + KMID_FRAME +
        _zwFromBits(_numToBits(r)) + KMID_FRAME +
        _zwFromBits(_numToBits(n)) + KMID_FRAME +
        _zwFromBits(_numToBits(cs)) + KMID_FRAME;
}

// name 末尾のゼロ幅タグを厳密検証。所有なら正準文字列 "runId:k"、非所有は null。
function _decodeId(name) {
    name = String(name);
    var L = name.length;
    if (L < 2 || name.charAt(L - 1) !== KMID_FRAME) { return null; }
    var i = L - 1;
    while (i >= 0 && _isZW(name.charAt(i))) { i--; }
    var parts = name.slice(i + 1).split(KMID_FRAME);
    if (parts.length !== 6 || parts[0] !== "" || parts[5] !== "") { return null; }
    var sigB = _zwToBits(parts[1]);
    if (sigB === null || sigB !== KMID_SIG) { return null; }
    var rB = _zwToBits(parts[2]), kB = _zwToBits(parts[3]), cB = _zwToBits(parts[4]);
    if (rB === null || kB === null || cB === null) { return null; }
    if (!rB.length || !kB.length || !cB.length) { return null; }
    if (_nonCanonical(rB) || _nonCanonical(kB) || _nonCanonical(cB)) { return null; }
    var runId = _bitsToNum(rB), k = _bitsToNum(kB), cs = _bitsToNum(cB);
    // K4-4: 安全整数上限（2^53-1）以下＋再エンコード一致（正準）を必須にする（parser.js と厳密一致）。
    if (runId > 9007199254740991 || k > 9007199254740991 || cs > 9007199254740991) { return null; }
    if (_numToBits(runId) !== rB || _numToBits(k) !== kB || _numToBits(cs) !== cB) { return null; }
    if (cs !== _checksum(runId, k)) { return null; }
    return _makeRid(runId, k);
}

// この拡張が所有するマーカーか（ゼロ幅IDが妥当に付いているか）
function _isOwned(name) { return _decodeId(name) !== null; }

function esc(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")
        .replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

// シーケンス識別子（sequenceID のみ）。実行中のシーケンス切替検知に使う。
// K3-2: name フォールバックはしない（同名シーケンスの誤判定を避ける）。取得不能なら "" を返し、呼び出し側で中止する。
function _seqId(seq) {
    var sid = "";
    try { sid = String(seq.sequenceID); } catch (e) {}
    if (!sid || sid === "undefined" || sid === "null") { return ""; }
    return sid;
}

function getSeqInfo() {
    var seq = app.project.activeSequence;
    if (!seq) { return '{"error":"アクティブなシーケンスがありません"}'; }
    var TICKS = 254016000000; // ticks per second
    var fps = 0, src = "";
    var tb = parseFloat(seq.timebase);
    if (tb > 0) { fps = TICKS / tb; src = "timebase"; }
    if (!(fps > 0)) {
        try {
            var st = seq.getSettings();
            var vfr = parseFloat(st.videoFrameRate.ticks);
            if (vfr > 0) { fps = TICKS / vfr; src = "settings"; }
        } catch (e) {}
    }
    var vdf = "";
    try { vdf = String(seq.videoDisplayFormat); } catch (e) { vdf = "n/a"; }
    var zero = "";
    try { zero = String(seq.zeroPoint); } catch (e) { zero = "n/a"; } // シーケンス開始TC(ticks)
    return '{"seq":"' + esc(seq.name) + '","seqId":"' + esc(_seqId(seq)) + '","fps":' + fps + ',"src":"' + src +
           '","timebase":"' + esc(seq.timebase) + '","vdf":"' + vdf + '","zeroPoint":"' + zero + '"}';
}

// 全マーカーを一覧化。K4-3: 対象シーケンスのIDを同じ応答に含めて 1 回の呼び出しで返す
//   （seqId取得と一覧取得が別evalScriptだと、その隙にシーケンスが変わり「Aの一覧＋BのseqId」で照合をすり抜ける）。
// 応答形式: seqId + CharCode(3) + 一覧本体。 一覧本体=レコード CharCode(2)区切／フィールド CharCode(1)区切 = ticks / name / comment / secs
//   （seqId は制御文字を含まないGUID。CharCode(3)=F3 は本体の F1(1)/F2(2) と重複しない区切り）
// エラー時のみ '{' 始まりのJSONを返す（パネルは先頭 '{' で判別）。seqId が空でも一覧は返す（個別操作側のガードで安全に弾く）。
// name はゼロ幅IDを含んだ生の値を返す（パネル側で復号・表示除去する）。
function listMarkers() {
    var seq = app.project.activeSequence;
    if (!seq) { return '{"error":"アクティブなシーケンスがありません"}'; }
    var F1 = String.fromCharCode(1), F2 = String.fromCharCode(2), F3 = String.fromCharCode(3);
    var out = "";
    var first = true;
    var m = seq.markers.getFirstMarker();
    while (m) {
        var ticks = "0", secs = "0";
        try { ticks = String(m.start.ticks); } catch (e) {}
        try { secs = String(m.start.seconds); } catch (e) {}
        if (!first) { out += F2; }
        out += ticks + F1 + (m.name || "") + F1 + (m.comments || "") + F1 + secs;
        first = false;
        m = seq.markers.getNextMarker(m);
    }
    return _seqId(seq) + F3 + out; // seqId + F3 + 本体（本体が空文字 = マーカー無し）
}

// 再生ヘッドを指定 ticks へ移動
function gotoMarker(ticks) {
    var seq = app.project.activeSequence;
    if (!seq) { return '{"error":"アクティブなシーケンスがありません"}'; }
    seq.setPlayerPosition(String(ticks)); // ticks は文字列で渡す
    return '{"ok":1}';
}

// listMarkers の並び順 idx 番目のマーカーを取得し、ticks が一致するか検証する（非所有マーカー用の二重キー）。
// この拡張が所有するマーカーは _findMarkerById（ゼロ幅IDの完全一致）で特定するのでこちらは使わない。
function _findMarker(seq, idx, ticks) {
    var m = seq.markers.getFirstMarker();
    var i = 0;
    while (m) {
        if (i === parseInt(idx, 10)) {
            try { if (String(m.start.ticks) === String(ticks)) { return m; } } catch (e) {}
            break; // idxズレ → ticksで探し直し
        }
        m = seq.markers.getNextMarker(m);
        i++;
    }
    m = seq.markers.getFirstMarker();
    while (m) {
        try { if (String(m.start.ticks) === String(ticks)) { return m; } } catch (e) {}
        m = seq.markers.getNextMarker(m);
    }
    return null;
}

// 所有マーカーを復号IDの完全一致で特定（K2-2: ticksフォールバックはしない。無ければ null=中止）
function _findMarkerById(seq, rid) {
    var target = String(rid);
    var m = seq.markers.getFirstMarker();
    while (m) {
        var d = _decodeId(m.name || "");
        if (d !== null && String(d) === target) { return m; }
        m = seq.markers.getNextMarker(m);
    }
    return null;
}

// rid（空でなければ所有マーカー→ID一致）優先。空なら非所有マーカーとして idx+ticks で特定。
function _resolveMarker(seq, rid, idx, ticks) {
    if (rid !== "" && rid !== null && String(rid) !== "undefined") {
        return _findMarkerById(seq, rid);
    }
    return _findMarker(seq, idx, ticks);
}

// マーカー色（環境によって未対応のことがあるので必ず try で包む）0=緑 1=赤
function _trySetColor(mk, idx) {
    try { mk.setColorByIndex(idx); return 1; } catch (e) { return 0; }
}

// 個別操作（編集/削除/済切替）の前に、一覧表示時のシーケンスと現在シーケンスが一致するか照合する（K3-7）。
// 不一致（非所有マーカーの idx+ticks が別シーケンスの別物に当たる事故を防ぐ）や seqId 取得不能なら中止メッセージを返す。
function _guardSeq(seq, expectSeqId) {
    var sid = _seqId(seq);
    if (!sid) { return '{"error":"シーケンスIDを取得できませんでした。もう一度お試しください"}'; }
    if (!expectSeqId || String(expectSeqId) !== sid) {
        return '{"error":"シーケンスが変わりました。一覧を更新してください"}';
    }
    return "";
}

// 済み⇔未済の切り替え。正は名前の「校正✅」プレフィックス（色APIが無くても成立）。ゼロ幅IDは末尾なので保持される。
function setMarkerDone(rid, idx, ticks, done, expectSeqId) {
    var seq = app.project.activeSequence;
    if (!seq) { return '{"error":"アクティブなシーケンスがありません"}'; }
    var g = _guardSeq(seq, expectSeqId); if (g) { return g; }
    var m = _resolveMarker(seq, rid, idx, ticks);
    if (!m) { return '{"error":"マーカーが見つかりません（一覧を更新してください）"}'; }
    var name = String(m.name || "");
    var colored;
    if (String(done) === "1") {
        if (name.indexOf("校正✅") !== 0) { m.name = name.replace(/^校正\s*/, "校正✅ "); }
        colored = _trySetColor(m, 0); // 緑
    } else {
        m.name = name.replace(/^校正✅\s*/, "校正 ");
        colored = _trySetColor(m, 1); // 赤
    }
    return '{"ok":1,"colored":' + colored + '}';
}

// マーカー1件削除
function deleteMarkerByTicks(rid, idx, ticks, expectSeqId) {
    var seq = app.project.activeSequence;
    if (!seq) { return '{"error":"アクティブなシーケンスがありません"}'; }
    var g = _guardSeq(seq, expectSeqId); if (g) { return g; }
    var m = _resolveMarker(seq, rid, idx, ticks);
    if (!m) { return '{"error":"マーカーが見つかりません（一覧を更新してください）"}'; }
    seq.markers.deleteMarker(m);
    return '{"removed":1}';
}

// マーカーのコメントを書き換え
function setMarkerComment(rid, idx, ticks, comment, expectSeqId) {
    var seq = app.project.activeSequence;
    if (!seq) { return '{"error":"アクティブなシーケンスがありません"}'; }
    var g = _guardSeq(seq, expectSeqId); if (g) { return g; }
    var m = _resolveMarker(seq, rid, idx, ticks);
    if (!m) { return '{"error":"マーカーが見つかりません（一覧を更新してください）"}'; }
    m.comments = comment;
    return '{"ok":1}';
}

// 所有マーカー（ゼロ幅IDあり）を削除。includeLegacy="1" のとき旧形式（'校正'前方一致でIDなし）も削除する。
// legacy には旧形式の件数を返す（includeLegacy=0 なら保持したまま件数だけ数える）。
function _clearOwnedInternal(seq, includeLegacy) {
    var removed = 0, legacy = 0;
    var m = seq.markers.getFirstMarker();
    while (m) {
        var next = seq.markers.getNextMarker(m);
        var nm = m.name || "";
        if (_decodeId(nm) !== null) {
            seq.markers.deleteMarker(m);
            removed++;
        } else if (nm.indexOf("校正") === 0) {
            if (String(includeLegacy) === "1") { seq.markers.deleteMarker(m); }
            legacy++;
        }
        m = next;
    }
    return { removed: removed, legacy: legacy };
}

// マーカーの一意な合成キー = 生の name（末尾ゼロ幅IDタグ込み）＋ 実 ticks。
// K5-1: 追加前スナップショット（_snapshotClearable）と削除照合（_clearBySnapshot）の識別キーに使う。
// name（＝rid＋本文）と ticks（＝フレーム）を同時に固定するので、runId 衝突（同じ rid）が起きても
// 旧マーカーと今回分は原則別キーになる。生name＋ticksまで完全一致する三重偶然のときは、
// 追加前スナップショットの多重集合（同一キーの件数）で「旧の件数分だけ」消すことで新規を巻き込まない（K5-1）。
function _markerKey(m) {
    var nm = m.name || "";
    var tk = "";
    try { tk = String(m.start.ticks); } catch (e) {}
    return nm + String.fromCharCode(1) + tk;
}

// K5-1: 追加を始める前の「削除候補スナップショット」を控える（多重集合＝同一キーの件数も保持）。
//   owned=所有マーカー（センチネル＋シグネチャ＋チェックサム検証OK）／legacy=旧形式（'校正'前方一致でセンチネル無し）。
//   キーは _markerKey（生name＋実ticks）。同一キーが複数あれば件数を数える。
//   これを追加前に撮ることで、追加後に増えた同一キーの新規マーカーはスナップショットに含まれない＝③で消されない。
function _snapshotClearable(seq) {
    var owned = {}, legacy = {};
    var m = seq.markers.getFirstMarker();
    while (m) {
        var nm = m.name || "";
        if (_decodeId(nm) !== null) {
            var ok = _markerKey(m);
            owned[ok] = (owned[ok] || 0) + 1;
        } else if (nm.indexOf("校正") === 0) {
            var lk = _markerKey(m);
            legacy[lk] = (legacy[lk] || 0) + 1;
        }
        m = seq.markers.getNextMarker(m);
    }
    return { owned: owned, legacy: legacy };
}

// K5-1: スナップショットに入っていたマーカーだけを削除する。多重集合の件数を消費しながら照合し、
//   スナップショット件数分だけ消す（＝追加後に増えた同一キーの新規マーカーは削除しない）。
//   参照 === でなく識別データ（生name＋実ticks）＋件数で照合するので、getFirstMarker/getNextMarker が
//   走査ごとに別ラッパーを返しても正しく動く。新規は追加前スナップショットに無いので原理的に除外される。
//   includeLegacy="1" のときだけ旧形式もスナップショット件数分だけ削除する。legacy に旧形式の削除件数を返す。
function _clearBySnapshot(seq, snap, includeLegacy) {
    var removed = 0, legacy = 0;
    var incLegacy = String(includeLegacy) === "1";
    var owned = snap.owned, legSnap = snap.legacy;
    var m = seq.markers.getFirstMarker();
    while (m) {
        var next = seq.markers.getNextMarker(m);
        var nm = m.name || "";
        if (_decodeId(nm) !== null) {
            var k = _markerKey(m);
            if (owned[k] > 0) { seq.markers.deleteMarker(m); owned[k]--; removed++; } // スナップショット件数分だけ消費
        } else if (nm.indexOf("校正") === 0) {
            if (incLegacy) {
                var lk = _markerKey(m);
                if (legSnap[lk] > 0) { seq.markers.deleteMarker(m); legSnap[lk]--; legacy++; }
            }
        }
        m = next;
    }
    return { removed: removed, legacy: legacy };
}

// 削除専用（リセットボタン用）。expectId で実行時シーケンスと照合。includeLegacy で旧形式も消すか指定。
// K3-2: seqId 取得不能／expectId 空／不一致 なら中止（同名シーケンスの誤判定・空expectId素通りを防ぐ）。
function clearKoseiMarkers(expectId, includeLegacy) {
    var seq = app.project.activeSequence;
    if (!seq) { return '{"error":"アクティブなシーケンスがありません"}'; }
    var sid = _seqId(seq);
    if (!sid) { return '{"error":"シーケンスIDを取得できませんでした。もう一度お試しください"}'; }
    if (!expectId || String(expectId) !== sid) {
        return '{"error":"シーケンスが変わりました。もう一度実行してください"}';
    }
    var r = _clearOwnedInternal(seq, includeLegacy);
    return '{"removed":' + r.removed + ',"legacy":' + r.legacy + '}';
}

// 削除と追加を1回の呼び出しに統合（K2-1）。順序は「①事前検証 → ②追加 → ③追加が全件成功したときだけ削除」（K3-1）。
// これにより「先に旧マーカーを消してから追加が途中失敗＝旧データ消失」を防ぐ（消失より一時的な重複を選ぶ）。
// payload: レコードを CharCode(2) 区切、各フィールドを CharCode(1) 区切 = frame / name / comment / runId / k
// expectId: 実行開始時のシーケンスID。K3-2: seqId不能／expectId空／不一致 なら何もせず中止。
function replaceMarkers(payload, expectId, clearFirst) {
    var seq = app.project.activeSequence;
    if (!seq) { return '{"error":"アクティブなシーケンスがありません"}'; }
    var sid = _seqId(seq);
    if (!sid) { return '{"error":"シーケンスIDを取得できませんでした。もう一度お試しください"}'; }
    if (!expectId || String(expectId) !== sid) {
        return '{"error":"シーケンスが変わりました。もう一度実行してください"}';
    }
    var TICKS = 254016000000;
    var tpf = parseFloat(seq.timebase); // ticks per frame
    if (!(tpf > 0)) { return '{"error":"timebase取得失敗: ' + esc(String(seq.timebase)) + '"}'; }

    var F1 = String.fromCharCode(1), F2 = String.fromCharCode(2);
    var recs = payload.split(F2);

    // ① 事前検証（K3-1）: 全レコードを削除・追加の前に検証。1件でも不正なら何も変更せず中止する。
    //    frame: 有限かつ非負 / runId,k: 空でない安全な非負整数 / name: 非空 / フィールド数: ちょうど5。
    var valid = [];
    for (var i = 0; i < recs.length; i++) {
        if (!recs[i]) { continue; }
        var f = recs[i].split(F1);
        // K4-5: フィールド数はちょうど5（frame/name/comment/runId/k）。過不足は細工/破損として中止（従来の <5 は余分フィールドを見逃した）。
        if (f.length !== 5) { return '{"error":"レコード形式が不正です（フィールド数が5でない）。処理を中止しました"}'; }
        var frame = _safeNonNegInt(f[0]);
        var nm = f[1] || "";
        var cmt = f[2] || "";
        var runId = _safeNonNegInt(f[3]);
        var k = _safeNonNegInt(f[4]);
        if (frame === null) { return '{"error":"フレーム値が不正なレコードがあります。処理を中止しました"}'; }
        if (runId === null || k === null) { return '{"error":"マーカーIDが不正なレコードがあります。処理を中止しました"}'; }
        if (nm === "") { return '{"error":"マーカー名が空のレコードがあります。処理を中止しました"}'; }
        valid.push({ frame: frame, nm: nm, cmt: cmt, runId: runId, k: k, rid: _makeRid(runId, k) });
    }
    if (valid.length === 0) { return '{"error":"追加できるレコードがありません"}'; }

    var cf = String(clearFirst) === "1";

    // K5-1: clearFirst時に削除する旧マーカーの「追加前スナップショット」を控える（多重集合＝同一キーの件数も保持）。
    //   追加を始める前に撮るので、追加後に増える同一キーの新規マーカーはこのスナップショットに含まれない。
    //   ③の削除はこのスナップショットの件数分だけに限定する＝生name＋ticksが完全一致しても新規は消さない・旧だけ消す。
    var clearSnap = null;
    if (cf) { clearSnap = _snapshotClearable(seq); }

    // clearFirst=OFF の再実行に備えた簡易dedupe: 既存の所有マーカーを「frame＋comment」で索引化（K2-3）
    var existing = null;
    if (!cf) {
        existing = {};
        var em = seq.markers.getFirstMarker();
        while (em) {
            if (_decodeId(em.name || "") !== null) {
                var et = 0;
                try { et = parseFloat(em.start.ticks); } catch (e0) {}
                var ef = Math.round(et / tpf);
                existing["k" + ef + F1 + (em.comments || "")] = 1; // "k" 前置で数値キー化を避ける
            }
            em = seq.markers.getNextMarker(em);
        }
    }

    // ② 追加（K3-1）: 新規マーカーを全部追加。作成後の name/comments 代入失敗はそのmkを削除して failed 計上（K2-4）。
    var added = 0, failed = 0, skipped = 0, idVerifyFailed = 0, errList = "";
    var maxDiff = 0;
    for (var j = 0; j < valid.length; j++) {
        var v = valid[j];
        try {
            if (existing) {
                var dk = "k" + v.frame + F1 + v.cmt;
                if (existing[dk]) { skipped++; continue; } // 同一TC＋同一本文の所有マーカーがあればスキップ
            }
            var sec = v.frame * tpf / TICKS;
            var mk = seq.markers.createMarker(sec);
            if (!mk) { throw new Error("createMarker失敗 @frame " + v.frame); }
            try {
                mk.name = v.nm + _encodeId(v.runId, v.k); // 所有権＆一意IDを付与（末尾ゼロ幅）
                mk.comments = v.cmt;
            } catch (setErr) {
                try { seq.markers.deleteMarker(mk); } catch (delErr) {}
                throw setErr;
            }
            // K4-1: IDが実際に定着したか検証。Premiereが名前から不可視文字を落とす/正規化する等でIDが付かない場合、
            //   added扱いにすると③の除外（identity照合）に失敗し、追加分・旧分ごと削除しうる。
            //   定着に失敗したレコードは「追加失敗」とみなし、そのmkを削除して idVerifyFailed/failed を計上する。
            //   failed が1件でも出れば③（旧削除）は走らない＝IDが機能しない環境では安全側（追加のみ・旧保持）に倒す。
            var back = _decodeId(String(mk.name));
            if (back === null || back !== v.rid) {
                try { seq.markers.deleteMarker(mk); } catch (e3) {}
                idVerifyFailed++;
                failed++;
                if (errList) { errList += ","; }
                errList += '"' + esc("ID定着失敗 @frame " + v.frame) + '"';
                continue;
            }
            _trySetColor(mk, 1); // 校正マーカーは赤（未対応環境では無視される）
            added++;
            if (existing) { existing["k" + v.frame + F1 + v.cmt] = 1; } // 同一payload内の重複も防ぐ
            try {
                var actualTicks = parseFloat(mk.start.ticks);
                var diff = (actualTicks - v.frame * tpf) / tpf;
                if (Math.abs(diff) > Math.abs(maxDiff)) { maxDiff = diff; }
            } catch (e2) {}
        } catch (e) {
            failed++;
            if (errList) { errList += ","; }
            errList += '"' + esc(String(e)) + '"';
        }
    }

    // ③ 削除（K3-1/K4-1/K5-1）: clearFirst かつ「追加が全件成功（failed===0＝ID定着失敗もゼロ）」のときだけ、
    //    追加前スナップショットに入っていた旧所有＋旧形式を、その件数分だけ削除する。
    //    新規は追加前スナップショットに含まれないので、生name＋ticksが完全一致しても消えない（K5-1）。
    //    追加/ID定着に1件でも失敗したら旧マーカーは削除しない（データ保全ゲート・維持）。
    var cleared = 0, oldCleared = 0;
    if (cf && failed === 0) {
        var cr = _clearBySnapshot(seq, clearSnap, "1");
        cleared = cr.removed;
        oldCleared = cr.legacy;
    }

    return '{"cleared":' + cleared + ',"oldCleared":' + oldCleared + ',"added":' + added + ',"failed":' + failed +
           ',"idVerifyFailed":' + idVerifyFailed +
           ',"skipped":' + skipped + ',"errors":[' + errList + '],"maxDiffFrames":' + maxDiff.toFixed(4) +
           ',"tpf":' + tpf + '}';
}
