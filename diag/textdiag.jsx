// ============================================================================
// KoseiMarker / テキスト取得診断（開発・調査専用）
//   ExtendScript 側。Premiere のシーケンスを走査して
//   VideoTrack → TrackItem → Component → ComponentParam を全部ダンプする。
//
// ※ これは「診断専用」。本番の校正マーカー処理（js/hostscript.jsx）からは完全に独立しており、
//   マーカーやクリップを一切変更しない（読み取りのみ）。
//
// ES3制約: const/let/アロー関数/テンプレート文字列は使えない。var と function のみ。
//   ExtendScript には JSON オブジェクトが無いので JSON は手組みで生成する。
//
// 使い方（パネル側から evalScript で呼ぶ）:
//   kmDiagRun(outPath, needle, maxClips, valueMode)
//     outPath   … レポートJSONの書き出し先フルパス（"" ならデスクトップに自動命名）
//     needle    … 探索したいテスト文字列（例 "TEXT_EXTRACT_TEST_12345"）。"" なら探索しない
//     maxClips  … 走査するクリップ数の上限（"0"/"" なら既定 MAX_CLIPS_TOTAL）
//     valueMode … "full"=全paramの値を読む / "meta"=名前と件数だけ（高速・安全）
//   戻り値 … 小さなサマリJSON（本体はファイルに書く。evalScript の戻り値サイズ制限を避けるため）
// ============================================================================

// ---- 安全上限（巨大データ・バイナリで Premiere を固めないため） ----
var KMD_MAX_VAL_CHARS = 4000;       // 1つの値として記録する最大文字数
var KMD_MAX_PARAMS = 400;           // 1 component あたりの param 上限
var KMD_MAX_COMPONENTS = 80;        // 1 clip あたりの component 上限
var KMD_MAX_CLIPS_TOTAL = 4000;     // 走査するクリップ総数の上限
var KMD_MAX_TOTAL_CHARS = 12000000; // レポート全体の文字数上限（超えたら打ち切ってフラグ）
var KMD_BINARY_CTRL_RATIO = 0.02;   // 制御文字がこの比率を超えたらバイナリ扱いで省略

// ---------------------------------------------------------------- JSON 手組み
// ES3 の String.replace でも安全に使える JSON 文字列エスケープ。
// 制御文字は \u00XX に、サロゲートはそのまま通す（UTF-8で書き出す）。
function kmdJstr(s) {
    if (s === null || s === undefined) { return 'null'; }
    var t = String(s);
    var out = '"';
    for (var i = 0; i < t.length; i++) {
        var c = t.charAt(i);
        var code = t.charCodeAt(i);
        if (c === '"') { out += '\\"'; }
        else if (c === '\\') { out += '\\\\'; }
        else if (c === '\n') { out += '\\n'; }
        else if (c === '\r') { out += '\\r'; }
        else if (c === '\t') { out += '\\t'; }
        else if (c === '\b') { out += '\\b'; }
        else if (c === '\f') { out += '\\f'; }
        else if (code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029) {
            var h = code.toString(16);
            while (h.length < 4) { h = '0' + h; }
            out += '\\u' + h;
        } else { out += c; }
    }
    return out + '"';
}

// 数値を JSON に。非有限は null（JSONにInfinity/NaNは無い）
function kmdJnum(n) {
    var v = Number(n);
    if (!isFinite(v)) { return 'null'; }
    return String(v);
}

function kmdJbool(b) { return b ? 'true' : 'false'; }

// ---------------------------------------------------------------- 文字列の性質判定
// 制御文字が多い＝バイナリ/非テキストとみなす（記録を省略して安全側に倒す）
function kmdIsBinaryish(t) {
    if (!t.length) { return false; }
    var ctrl = 0;
    var lim = t.length < 4096 ? t.length : 4096;
    for (var i = 0; i < lim; i++) {
        var c = t.charCodeAt(i);
        if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) { ctrl++; }
        if (c === 0) { return true; } // NUL があれば即バイナリ
    }
    return (ctrl / lim) > KMD_BINARY_CTRL_RATIO;
}

// JSONらしい文字列か（Graphic本文が JSON で露出しているケースを拾う）
function kmdLooksJson(t) {
    var s = t;
    // ES3: trim が無いので手で落とす
    s = s.replace(/^[\s　]+/, '').replace(/[\s　]+$/, '');
    if (!s.length) { return false; }
    var a = s.charAt(0), b = s.charAt(s.length - 1);
    return (a === '{' && b === '}') || (a === '[' && b === ']');
}

// JSONらしい文字列から「テキスト本文っぽいキー」を総当たりで抜く。
//   Premiere/AE の Source Text は textEditValue / mRawText / rawText 等に入るという
//   コミュニティ報告がある。名前を決め打ちせず /text/i にマッチするキーを全部拾う。
//   ※ 正規のJSONパーサではない（ExtendScript に JSON が無いため）。診断用の近似抽出。
function kmdJsonTextKeys(t) {
    var found = [];
    // "key" : "value"  （value 内のエスケープ \" を考慮）
    var re = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    var m;
    var guard = 0;
    while ((m = re.exec(t)) !== null) {
        guard++;
        if (guard > 2000) { break; } // 暴走防止
        var key = m[1];
        if (/text/i.test(key)) {
            var val = m[2];
            // JSON内のエスケープを軽く戻す（診断表示用）
            val = val.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
                     .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            found.push({ key: key, value: val });
        }
        if (found.length >= 40) { break; }
    }
    return found;
}

// ---------------------------------------------------------------- 収集バッファ
function kmdBuf() {
    return { parts: [], chars: 0, truncated: false };
}
function kmdPush(buf, s) {
    if (buf.truncated) { return false; }
    var t = String(s);
    if (buf.chars + t.length > KMD_MAX_TOTAL_CHARS) {
        buf.truncated = true;
        return false;
    }
    buf.parts.push(t);
    buf.chars += t.length;
    return true;
}

// ---------------------------------------------------------------- Time 取得
// Time オブジェクトは環境差があるので必ず try で包み、取れたものだけ返す。
function kmdTime(tObj) {
    var ticks = null, secs = null;
    try { if (tObj && tObj.ticks !== undefined) { ticks = String(tObj.ticks); } } catch (e1) {}
    try { if (tObj && tObj.seconds !== undefined) { secs = Number(tObj.seconds); } } catch (e2) {}
    return '{"ticks":' + (ticks === null ? 'null' : kmdJstr(ticks)) +
           ',"seconds":' + (secs === null ? 'null' : kmdJnum(secs)) + '}';
}

// ---------------------------------------------------------------- 値の記録
// ComponentParam の値を1つ記録する。
//   needleState … { needle:"...", hits:[] } 見つかった場所を貯める
//   where       … ヒット位置を説明する文字列
function kmdValueJson(label, getter, where, needleState) {
    var res = '{"call":' + kmdJstr(label);
    var v;
    try {
        v = getter();
    } catch (e) {
        return res + ',"ok":false,"error":' + kmdJstr(String(e && e.message ? e.message : e)) + '}';
    }
    res += ',"ok":true';
    var ty = typeof v;
    res += ',"type":' + kmdJstr(ty === 'object' && v === null ? 'null' : ty);

    if (v === null || v === undefined) {
        return res + ',"value":null}';
    }
    if (ty === 'number') { return res + ',"value":' + kmdJnum(v) + '}'; }
    if (ty === 'boolean') { return res + ',"value":' + kmdJbool(v) + '}'; }

    if (ty === 'string') {
        var t = String(v);
        res += ',"len":' + kmdJnum(t.length);
        if (kmdIsBinaryish(t)) {
            // バイナリらしい値は本文を残さない（安全な省略）
            return res + ',"omitted":"binaryish","preview":' + kmdJstr(t.substring(0, 32).replace(/[\x00-\x1f]/g, '.')) + '}';
        }
        var truncated = false;
        if (t.length > KMD_MAX_VAL_CHARS) { t = t.substring(0, KMD_MAX_VAL_CHARS); truncated = true; }
        res += ',"truncated":' + kmdJbool(truncated);
        res += ',"value":' + kmdJstr(t);
        var lj = kmdLooksJson(String(v));
        res += ',"looksJson":' + kmdJbool(lj);
        if (lj) {
            var keys = kmdJsonTextKeys(String(v));
            if (keys.length) {
                var ks = [];
                for (var i = 0; i < keys.length; i++) {
                    var kv = keys[i].value;
                    var kt = false;
                    if (kv.length > KMD_MAX_VAL_CHARS) { kv = kv.substring(0, KMD_MAX_VAL_CHARS); kt = true; }
                    ks.push('{"key":' + kmdJstr(keys[i].key) + ',"value":' + kmdJstr(kv) +
                            ',"truncated":' + kmdJbool(kt) + '}');
                }
                res += ',"jsonTextKeys":[' + ks.join(',') + ']';
            }
        }
        // テスト文字列の探索（STEP4）。値全体（切り詰め前）に対して行う。
        if (needleState && needleState.needle && String(v).indexOf(needleState.needle) !== -1) {
            needleState.hits.push('{"where":' + kmdJstr(where + ' / ' + label) + '}');
            res += ',"needleFound":true';
        }
        return res + '}';
    }

    // object / array / その他（Color配列や Time など）
    if (ty === 'object') {
        // 配列っぽい？
        var isArr = false;
        try { isArr = (typeof v.length === 'number' && !(v instanceof String)); } catch (e3) {}
        if (isArr) {
            var n = 0;
            try { n = v.length; } catch (e4) {}
            if (n > 64) { n = 64; }
            var items = [];
            for (var j = 0; j < n; j++) {
                var el;
                try { el = v[j]; } catch (e5) { el = null; }
                var et = typeof el;
                if (et === 'number') { items.push(kmdJnum(el)); }
                else if (et === 'boolean') { items.push(kmdJbool(el)); }
                else if (et === 'string') { items.push(kmdJstr(String(el).substring(0, 200))); }
                else { items.push(kmdJstr('[' + et + ']')); }
            }
            return res + ',"arrayLike":true,"array":[' + items.join(',') + ']}';
        }
        // オブジェクト: 既知の取り出し口（reflect）を安全に試す
        var desc = [];
        try {
            if (v.reflect && v.reflect.properties) {
                var props = v.reflect.properties;
                var lim = props.length < 40 ? props.length : 40;
                for (var p = 0; p < lim; p++) {
                    var pn;
                    try { pn = String(props[p].name); } catch (e6) { continue; }
                    if (pn === '__proto__' || pn === 'reflect') { continue; }
                    var pv;
                    try { pv = v[pn]; } catch (e7) { continue; }
                    var pt = typeof pv;
                    if (pt === 'number') { desc.push('{"k":' + kmdJstr(pn) + ',"t":"number","v":' + kmdJnum(pv) + '}'); }
                    else if (pt === 'boolean') { desc.push('{"k":' + kmdJstr(pn) + ',"t":"boolean","v":' + kmdJbool(pv) + '}'); }
                    else if (pt === 'string') {
                        var sv = String(pv);
                        if (needleState && needleState.needle && sv.indexOf(needleState.needle) !== -1) {
                            needleState.hits.push('{"where":' + kmdJstr(where + ' / ' + label + '.' + pn) + '}');
                        }
                        desc.push('{"k":' + kmdJstr(pn) + ',"t":"string","v":' + kmdJstr(sv.substring(0, 600)) + '}');
                    } else { desc.push('{"k":' + kmdJstr(pn) + ',"t":' + kmdJstr(pt) + '}'); }
                }
            }
        } catch (e8) {}
        var tostr = '';
        try { tostr = String(v); } catch (e9) { tostr = '(toString失敗)'; }
        if (needleState && needleState.needle && tostr.indexOf(needleState.needle) !== -1) {
            needleState.hits.push('{"where":' + kmdJstr(where + ' / ' + label + '.toString()') + '}');
        }
        return res + ',"toString":' + kmdJstr(tostr.substring(0, 600)) +
               ',"props":[' + desc.join(',') + ']}';
    }

    return res + ',"value":' + kmdJstr('(' + ty + ')') + '}';
}

// ---------------------------------------------------------------- ComponentParam 1件
function kmdParamJson(param, idx, where, needleState, valueMode) {
    var o = '{"index":' + kmdJnum(idx);
    // .name は docsforadobe 未記載だが Adobe公式サンプル PProPanel が使っている（要実機確認）
    var nm = null, dn = null;
    try { if (param.name !== undefined) { nm = String(param.name); } } catch (e1) {}
    try { if (param.displayName !== undefined) { dn = String(param.displayName); } } catch (e2) {}
    o += ',"name":' + (nm === null ? 'null' : kmdJstr(nm));
    o += ',"displayName":' + (dn === null ? 'null' : kmdJstr(dn));

    var where2 = where + ' / param[' + idx + ']' + (dn ? '("' + dn + '")' : '');

    // displayName / name にテスト文字列が入っていることもある（レイヤー名＝本文のケース）
    if (needleState && needleState.needle) {
        if (nm && nm.indexOf(needleState.needle) !== -1) { needleState.hits.push('{"where":' + kmdJstr(where2 + ' / param.name') + '}'); }
        if (dn && dn.indexOf(needleState.needle) !== -1) { needleState.hits.push('{"where":' + kmdJstr(where2 + ' / param.displayName') + '}'); }
    }

    if (valueMode === 'meta') { return o + ',"valueMode":"meta"}'; }

    var calls = [];
    calls.push(kmdValueJson('getValue()', function () { return param.getValue(); }, where2, needleState));
    // getValueAtTime は Time/秒のどちらを取るか環境差があるので両方試す
    calls.push(kmdValueJson('getValueAtTime(0)', function () { return param.getValueAtTime(0); }, where2, needleState));
    calls.push(kmdValueJson('isTimeVarying()', function () { return param.isTimeVarying(); }, where2, needleState));
    calls.push(kmdValueJson('areKeyframesSupported()', function () { return param.areKeyframesSupported(); }, where2, needleState));
    o += ',"calls":[' + calls.join(',') + ']';
    return o + '}';
}

// ---------------------------------------------------------------- Component 1件
function kmdComponentJson(comp, idx, where, needleState, valueMode) {
    var o = '{"index":' + kmdJnum(idx);
    var mn = null, dn = null;
    try { if (comp.matchName !== undefined) { mn = String(comp.matchName); } } catch (e1) {}
    try { if (comp.displayName !== undefined) { dn = String(comp.displayName); } } catch (e2) {}
    o += ',"matchName":' + (mn === null ? 'null' : kmdJstr(mn));
    o += ',"displayName":' + (dn === null ? 'null' : kmdJstr(dn));

    var where2 = where + ' / component[' + idx + ']' + (mn ? '(' + mn + ')' : '');

    var props = null;
    try { props = comp.properties; } catch (e3) {
        return o + ',"paramsError":' + kmdJstr(String(e3 && e3.message ? e3.message : e3)) + '}';
    }
    if (!props) { return o + ',"paramCount":null,"params":[]}'; }

    var n = 0;
    try { n = props.numItems; } catch (e4) { n = 0; }
    o += ',"paramCount":' + kmdJnum(n);

    // 公式サンプル PProPanel が使う getParamForDisplayName の存在も記録する（英語/日本語の両方を試す）
    var byName = [];
    var probeNames = ['Source Text', 'ソーステキスト', 'Text', 'テキスト'];
    for (var q = 0; q < probeNames.length; q++) {
        var pn = probeNames[q];
        var entry = '{"displayName":' + kmdJstr(pn);
        try {
            if (typeof props.getParamForDisplayName !== 'function') {
                entry += ',"available":false,"error":"getParamForDisplayName が存在しない"}';
            } else {
                var fp = props.getParamForDisplayName(pn);
                if (!fp) { entry += ',"available":true,"found":false}'; }
                else {
                    entry += ',"available":true,"found":true,"param":' +
                             kmdParamJson(fp, -1, where2 + ' / getParamForDisplayName("' + pn + '")', needleState, valueMode) + '}';
                }
            }
        } catch (e5) {
            entry += ',"available":true,"error":' + kmdJstr(String(e5 && e5.message ? e5.message : e5)) + '}';
        }
        byName.push(entry);
    }
    o += ',"byDisplayName":[' + byName.join(',') + ']';

    var lim = n < KMD_MAX_PARAMS ? n : KMD_MAX_PARAMS;
    var ps = [];
    for (var i = 0; i < lim; i++) {
        var p = null;
        try { p = props[i]; } catch (e6) {}
        if (!p) { ps.push('{"index":' + i + ',"error":"param取得失敗"}'); continue; }
        ps.push(kmdParamJson(p, i, where2, needleState, valueMode));
    }
    o += ',"paramsTruncated":' + kmdJbool(n > lim);
    o += ',"params":[' + ps.join(',') + ']';
    return o + '}';
}

// ---------------------------------------------------------------- TrackItem 1件
function kmdClipJson(clip, trackIdx, clipIdx, needleState, valueMode) {
    var where = 'V' + (trackIdx + 1) + ' / clip[' + clipIdx + ']';
    var o = '{"trackIndex":' + kmdJnum(trackIdx) + ',"clipIndex":' + kmdJnum(clipIdx);

    var nm = null;
    try { if (clip.name !== undefined) { nm = String(clip.name); } } catch (e1) {}
    o += ',"name":' + (nm === null ? 'null' : kmdJstr(nm));
    if (needleState && needleState.needle && nm && nm.indexOf(needleState.needle) !== -1) {
        needleState.hits.push('{"where":' + kmdJstr(where + ' / trackItem.name') + '}');
    }

    // 属性（環境差があるので個別に try）
    o += ',"matchName":' + kmdValueJson('getMatchName()', function () { return clip.getMatchName(); }, where, needleState);
    o += ',"matchNameAttr":' + kmdValueJson('matchName', function () { return clip.matchName; }, where, needleState);
    o += ',"nodeId":' + kmdValueJson('nodeId', function () { return clip.nodeId; }, where, needleState);
    o += ',"mediaType":' + kmdValueJson('mediaType', function () { return clip.mediaType; }, where, needleState);
    o += ',"type":' + kmdValueJson('type', function () { return clip.type; }, where, needleState);
    o += ',"disabled":' + kmdValueJson('disabled', function () { return clip.disabled; }, where, needleState);
    o += ',"isAdjustmentLayer":' + kmdValueJson('isAdjustmentLayer()', function () { return clip.isAdjustmentLayer(); }, where, needleState);
    o += ',"isSelected":' + kmdValueJson('isSelected()', function () { return clip.isSelected(); }, where, needleState);
    o += ',"speed":' + kmdValueJson('getSpeed()', function () { return clip.getSpeed(); }, where, needleState);

    var st = null, en = null, ip = null, op = null, du = null;
    try { st = clip.start; } catch (e2) {}
    try { en = clip.end; } catch (e3) {}
    try { ip = clip.inPoint; } catch (e4) {}
    try { op = clip.outPoint; } catch (e5) {}
    try { du = clip.duration; } catch (e6) {}
    o += ',"start":' + kmdTime(st) + ',"end":' + kmdTime(en);
    o += ',"inPoint":' + kmdTime(ip) + ',"outPoint":' + kmdTime(op) + ',"duration":' + kmdTime(du);

    // projectItem（ネスト判定にも使う）
    var pi = null;
    try { pi = clip.projectItem; } catch (e7) {}
    if (!pi) { o += ',"projectItem":null'; }
    else {
        var pio = '{';
        pio += '"name":' + kmdValueJson('projectItem.name', function () { return pi.name; }, where, needleState);
        pio += ',"nodeId":' + kmdValueJson('projectItem.nodeId', function () { return pi.nodeId; }, where, needleState);
        pio += ',"type":' + kmdValueJson('projectItem.type', function () { return pi.type; }, where, needleState);
        pio += ',"isSequence":' + kmdValueJson('projectItem.isSequence()', function () { return pi.isSequence(); }, where, needleState);
        pio += ',"mediaPath":' + kmdValueJson('projectItem.getMediaPath()', function () { return pi.getMediaPath(); }, where, needleState);
        // マスタークリップ側のコンポーネント（Graphic本文がこちらに居る可能性の検証）
        pio += ',"videoComponents":' + kmdValueJson('projectItem.videoComponents().numItems', function () { return pi.videoComponents().numItems; }, where, needleState);
        o += ',"projectItem":' + pio + '}';
    }

    // MOGRT コンポーネント（AE製 .mogrt の公開パラメータ。Premiere製では null 報告あり＝実機確認対象）
    var mgtSec = '{';
    var moComp = null, mgtErr = null;
    try {
        if (typeof clip.getMGTComponent !== 'function') { mgtErr = 'getMGTComponent が存在しない'; }
        else { moComp = clip.getMGTComponent(); }
    } catch (e8) { mgtErr = String(e8 && e8.message ? e8.message : e8); }
    if (mgtErr !== null) { mgtSec += '"available":false,"error":' + kmdJstr(mgtErr); }
    else if (!moComp) { mgtSec += '"available":true,"component":null,"note":"getMGTComponent() が null を返した"'; }
    else {
        mgtSec += '"available":true,"component":' +
                  kmdComponentJson(moComp, -1, where + ' / getMGTComponent()', needleState, valueMode);
    }
    o += ',"mgt":' + mgtSec + '}';

    // 通常の components（イントリンシック＋エフェクト）
    var comps = null, compErr = null;
    try { comps = clip.components; } catch (e9) { compErr = String(e9 && e9.message ? e9.message : e9); }
    if (compErr !== null) { o += ',"componentsError":' + kmdJstr(compErr) + ',"components":[]'; }
    else if (!comps) { o += ',"componentCount":null,"components":[]'; }
    else {
        var cn = 0;
        try { cn = comps.numItems; } catch (e10) { cn = 0; }
        o += ',"componentCount":' + kmdJnum(cn);
        var clim = cn < KMD_MAX_COMPONENTS ? cn : KMD_MAX_COMPONENTS;
        var cs = [];
        for (var i = 0; i < clim; i++) {
            var c = null;
            try { c = comps[i]; } catch (e11) {}
            if (!c) { cs.push('{"index":' + i + ',"error":"component取得失敗"}'); continue; }
            cs.push(kmdComponentJson(c, i, where, needleState, valueMode));
        }
        o += ',"componentsTruncated":' + kmdJbool(cn > clim);
        o += ',"components":[' + cs.join(',') + ']';
    }

    return o + '}';
}

// ---------------------------------------------------------------- ホスト情報
function kmdHostInfo() {
    var o = '{';
    o += '"appVersion":' + kmdValueJson('app.version', function () { return app.version; }, 'app', null);
    o += ',"appBuild":' + kmdValueJson('app.build', function () { return app.build; }, 'app', null);
    o += ',"locale":' + kmdValueJson('$.locale', function () { return $.locale; }, 'app', null);
    o += ',"esVersion":' + kmdValueJson('$.version', function () { return $.version; }, 'app', null);
    o += ',"os":' + kmdValueJson('$.os', function () { return $.os; }, 'app', null);
    return o + '}';
}

// ---------------------------------------------------------------- シーケンス情報
function kmdSeqInfo(seq) {
    var TICKS = 254016000000;
    var o = '{';
    o += '"name":' + kmdValueJson('seq.name', function () { return seq.name; }, 'seq', null);
    o += ',"sequenceID":' + kmdValueJson('seq.sequenceID', function () { return seq.sequenceID; }, 'seq', null);
    o += ',"timebase":' + kmdValueJson('seq.timebase', function () { return seq.timebase; }, 'seq', null);
    o += ',"zeroPoint":' + kmdValueJson('seq.zeroPoint', function () { return seq.zeroPoint; }, 'seq', null);
    o += ',"videoDisplayFormat":' + kmdValueJson('seq.videoDisplayFormat', function () { return seq.videoDisplayFormat; }, 'seq', null);
    var fps = null;
    try {
        var tb = parseFloat(seq.timebase);
        if (tb > 0) { fps = TICKS / tb; }
    } catch (e1) {}
    o += ',"fps":' + (fps === null ? 'null' : kmdJnum(fps));
    o += ',"videoTrackCount":' + kmdValueJson('seq.videoTracks.numTracks', function () { return seq.videoTracks.numTracks; }, 'seq', null);
    o += ',"audioTrackCount":' + kmdValueJson('seq.audioTracks.numTracks', function () { return seq.audioTracks.numTracks; }, 'seq', null);
    return o + '}';
}

// ---------------------------------------------------------------- メイン
function kmDiagRun(outPath, needle, maxClips, valueMode) {
    var seq = app.project.activeSequence;
    if (!seq) { return '{"error":"アクティブなシーケンスがありません"}'; }

    valueMode = (String(valueMode) === 'meta') ? 'meta' : 'full';
    var maxC = parseInt(maxClips, 10);
    if (!isFinite(maxC) || maxC <= 0) { maxC = KMD_MAX_CLIPS_TOTAL; }

    var needleState = { needle: (needle === null || needle === undefined) ? '' : String(needle), hits: [] };

    var buf = kmdBuf();
    var errs = [];

    kmdPush(buf, '{"schema":"koseimarker.textdiag/1"');
    kmdPush(buf, ',"generatedAt":' + kmdJstr(new Date().toString()));
    kmdPush(buf, ',"valueMode":' + kmdJstr(valueMode));
    kmdPush(buf, ',"host":' + kmdHostInfo());
    kmdPush(buf, ',"sequence":' + kmdSeqInfo(seq));
    kmdPush(buf, ',"limits":{"maxValChars":' + KMD_MAX_VAL_CHARS +
                 ',"maxParams":' + KMD_MAX_PARAMS +
                 ',"maxComponents":' + KMD_MAX_COMPONENTS +
                 ',"maxClips":' + maxC +
                 ',"maxTotalChars":' + KMD_MAX_TOTAL_CHARS + '}');

    var vt = null;
    try { vt = seq.videoTracks; } catch (e1) {}
    if (!vt) { return '{"error":"videoTracks を取得できませんでした"}'; }

    var ntracks = 0;
    try { ntracks = vt.numTracks; } catch (e2) { ntracks = 0; }

    var totalClips = 0, scannedClips = 0, textishClips = 0;
    kmdPush(buf, ',"tracks":[');
    var firstTrack = true;

    for (var ti = 0; ti < ntracks; ti++) {
        var track = null;
        try { track = vt[ti]; } catch (e3) {}
        if (!track) { errs.push(kmdJstr('V' + (ti + 1) + ': track取得失敗')); continue; }

        var clips = null;
        try { clips = track.clips; } catch (e4) {}
        var nclips = 0;
        try { nclips = clips ? clips.numItems : 0; } catch (e5) { nclips = 0; }
        totalClips += nclips;

        if (!firstTrack) { kmdPush(buf, ','); }
        firstTrack = false;
        kmdPush(buf, '{"trackIndex":' + ti + ',"label":"V' + (ti + 1) + '"');
        kmdPush(buf, ',"name":' + kmdValueJson('track.name', function () { return track.name; }, 'V' + (ti + 1), null));
        kmdPush(buf, ',"isMuted":' + kmdValueJson('track.isMuted()', function () { return track.isMuted(); }, 'V' + (ti + 1), null));
        kmdPush(buf, ',"clipCount":' + kmdJnum(nclips));
        kmdPush(buf, ',"clips":[');

        var firstClip = true;
        for (var ci = 0; ci < nclips; ci++) {
            if (scannedClips >= maxC) { break; }
            if (buf.truncated) { break; }
            var clip = null;
            try { clip = clips[ci]; } catch (e6) {}
            if (!clip) { errs.push(kmdJstr('V' + (ti + 1) + ' clip[' + ci + ']: 取得失敗')); continue; }
            var js;
            try {
                js = kmdClipJson(clip, ti, ci, needleState, valueMode);
            } catch (e7) {
                js = '{"trackIndex":' + ti + ',"clipIndex":' + ci +
                     ',"fatalError":' + kmdJstr(String(e7 && e7.message ? e7.message : e7)) + '}';
                errs.push(kmdJstr('V' + (ti + 1) + ' clip[' + ci + ']: ' + String(e7 && e7.message ? e7.message : e7)));
            }
            if (!firstClip) { kmdPush(buf, ','); }
            firstClip = false;
            kmdPush(buf, js);
            scannedClips++;
        }
        kmdPush(buf, ']}');
        if (buf.truncated) { break; }
    }
    kmdPush(buf, ']');

    kmdPush(buf, ',"needle":{"value":' + kmdJstr(needleState.needle) +
                 ',"hitCount":' + needleState.hits.length +
                 ',"hits":[' + needleState.hits.join(',') + ']}');
    kmdPush(buf, ',"stats":{"videoTrackCount":' + ntracks +
                 ',"totalClips":' + totalClips +
                 ',"scannedClips":' + scannedClips + '}');
    kmdPush(buf, ',"errors":[' + errs.join(',') + ']');
    kmdPush(buf, ',"truncated":' + kmdJbool(buf.truncated));
    kmdPush(buf, '}');

    var json = buf.parts.join('');

    // 出力先。"" ならデスクトップに自動命名。
    var path = String(outPath || '');
    if (!path) {
        var d = new Date();
        function z2(n) { return (n < 10 ? '0' : '') + n; }
        var stamp = d.getFullYear() + z2(d.getMonth() + 1) + z2(d.getDate()) + '-' +
                    z2(d.getHours()) + z2(d.getMinutes()) + z2(d.getSeconds());
        path = Folder.desktop.fsName + '/KoseiMarker-textdiag-' + stamp + '.json';
    }

    var wrote = false, writeErr = '';
    try {
        var f = new File(path);
        f.encoding = 'UTF-8';
        if (f.open('w')) {
            f.write(json);
            f.close();
            wrote = true;
        } else { writeErr = 'ファイルを開けませんでした'; }
    } catch (e8) { writeErr = String(e8 && e8.message ? e8.message : e8); }

    // サマリだけ返す（本体はファイル。evalScript の戻り値サイズ制限を回避）
    return '{"ok":1,"wrote":' + kmdJbool(wrote) +
           ',"path":' + kmdJstr(path) +
           ',"writeError":' + kmdJstr(writeErr) +
           ',"bytesApprox":' + kmdJnum(json.length) +
           ',"videoTrackCount":' + kmdJnum(ntracks) +
           ',"totalClips":' + kmdJnum(totalClips) +
           ',"scannedClips":' + kmdJnum(scannedClips) +
           ',"needleHits":' + kmdJnum(needleState.hits.length) +
           ',"errorCount":' + kmdJnum(errs.length) +
           ',"truncated":' + kmdJbool(buf.truncated) + '}';
}
