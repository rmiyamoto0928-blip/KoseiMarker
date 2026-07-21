// 校正マーカー 入力パーサー（UI非依存。node でテスト可能）
// 対応形式:
//   1) 縦並び（TC行 → 現在 → 修正案）
//   2) タブ区切り（TC[Tab]現在[Tab]修正案）
//   3) Markdown表 3列（typo-check統合レポート: | TC | 該当テキスト | 修正案 |）
//   4) Markdown表 6列（添削指示書: | # | TC | 該当テキスト | 修正案 | 理由 | 重要度 |）
// タイムコード:
//   HH;MM;SS;FF / HH:MM:SS:FF（フレーム精度） / MM:SS・HH:MM:SS（秒精度）
//   HH:MM:SS,mmm / HH:MM:SS.mmm（SRT・ミリ秒精度）
//   範囲表記「開始〜終了」（〜 ～ ~ - – —）は開始TCを採用（マーカー名には範囲のまま表示）
//   タブ喪失コピペ（TC＋空白＋本文）にも対応（区切り＝タブ/2連半角空白/全角空白）
(function (root) {
    'use strict';

    // TC文字列を解析。成功: {kind:'frames'|'ms', hh,mm,ss, ff|ms, precise, raw} ／ 失敗: null
    // precise=false は「秒までしか分からないTC」（微調整プリセットの適用対象）
    // fps を渡すとフレーム値の範囲検証（ff < 公称fps）も行う。分>=60/秒>=60 は fps 無しでも無効（K2-7）。
    function parseTC(s, fps) {
        s = String(s).trim();
        var m = s.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/); // SRT形式
        if (m) {
            var mmS = +m[2], ssS = +m[3];
            if (mmS >= 60 || ssS >= 60) { return null; } // 範囲外（K2-7）
            var ms = parseInt((m[4] + '00').slice(0, 3), 10);
            return { kind: 'ms', hh: +m[1], mm: mmS, ss: ssS, ms: ms, precise: true, raw: s };
        }
        if (!/^\d{1,2}([;:]\d{1,2}){1,3}$/.test(s)) { return null; }
        var p = s.split(/[;:]/);
        for (var i = 0; i < p.length; i++) { p[i] = parseInt(p[i], 10); }
        var hh, mm, ss, ff, precise;
        if (p.length === 2 && s.indexOf(';') !== -1) { return null; } // 「05;10」はMM;SSかSS;FFか判別不能
        if (p.length === 2) { hh = 0; mm = p[0]; ss = p[1]; ff = 0; precise = false; }
        else if (p.length === 3) { hh = p[0]; mm = p[1]; ss = p[2]; ff = 0; precise = false; }
        else { hh = p[0]; mm = p[1]; ss = p[2]; ff = p[3]; precise = true; }
        if (mm >= 60 || ss >= 60) { return null; } // 分/秒の範囲外（K2-7）
        if (precise && fps && fps > 0 && ff >= Math.round(fps)) { return null; } // フレーム範囲外（K2-7）
        return { kind: 'frames', hh: hh, mm: mm, ss: ss, ff: ff, precise: precise, raw: s };
    }

    // TC → フレーム番号（conf: {fps, nominal, drop}）
    // 秒精度TC(0:34等)とSRT形式は「実時間」として実fpsで換算する
    // （名目30コマ×秒で数えると29.97fpsでは10分で約18コマ後ろへズレるため）
    function tcToFrame(tc, conf) {
        if (tc.kind === 'ms' || !tc.precise) {
            var sec = tc.hh * 3600 + tc.mm * 60 + tc.ss + (tc.ms ? tc.ms / 1000 : 0);
            return Math.round(sec * conf.fps);
        }
        var frame = ((tc.hh * 3600 + tc.mm * 60 + tc.ss) * conf.nominal) + tc.ff;
        if (conf.drop) {
            var dpm = conf.nominal >= 60 ? 4 : 2;
            var totalMin = tc.hh * 60 + tc.mm;
            frame -= dpm * (totalMin - Math.floor(totalMin / 10));
        }
        return frame;
    }

    // TCセル解析：範囲表記「開始〜終了」（〜 ～ ~ - – —）は開始TCを採用する
    // （00;00;57;12〜00;01;01;16 のような行が丸ごと捨てられていた実運用バグの恒久修正・2026-07-21）
    function parseTCCell(s, fps) {
        s = String(s).trim();
        var direct = parseTC(s, fps);
        if (direct) { return direct; }
        var m = s.match(/^(.+?)\s*[〜～~\-–—]\s*(.+)$/);
        if (m && parseTC(m[1], fps) && parseTC(m[2], fps)) { return parseTC(m[1], fps); }
        return null;
    }

    function cleanCell(s) {
        return String(s).replace(/<br\s*\/?>/gi, ' ').replace(/\*\*/g, '').trim();
    }

    // Markdown表の1行をセルに分割。バックスラッシュのエスケープを正しく解釈する（K2-6）:
    //   \| … セル内のリテラル | ／ \\ … リテラル \ ／ 素の | … 列区切り
    // 先頭/末尾の「境界パイプ」は構文的に1文字だけ除去する。末尾パイプはエスケープされていない
    // （直前のバックスラッシュ数が偶数の）ときだけ境界とみなす＝ escaped \| を末尾で誤除去しない。
    // 末尾の空セルも保持する（列数の厳密判定のため。従来の \|+$ は空セルを畳んで列ズレ誤採用を招いた）。
    function splitMdCells(t) {
        var s = String(t).trim();
        if (s.charAt(0) === '|') { s = s.slice(1); } // 先頭境界を1つ除去
        if (s.length && s.charAt(s.length - 1) === '|') {
            var bs = 0, k = s.length - 2;
            while (k >= 0 && s.charAt(k) === '\\') { bs++; k--; }
            if (bs % 2 === 0) { s = s.slice(0, s.length - 1); } // エスケープされていない末尾境界のみ除去
        }
        var cells = [];
        var buf = '';
        for (var i = 0; i < s.length; i++) {
            var ch = s.charAt(i);
            if (ch === '\\') {
                var nx = s.charAt(i + 1);
                if (nx === '|' || nx === '\\') { buf += nx; i++; continue; }
                buf += ch; continue;
            }
            if (ch === '|') { cells.push(buf); buf = ''; continue; }
            buf += ch;
        }
        cells.push(buf);
        return cells;
    }

    // 「TCとして書こうとしている」セルか（parseTCが不採用でも判別を試みる）。見逃し警告の判定に使う
    function looksLikeTC(s) {
        s = String(s).trim();
        var m = s.match(/^(.+?)\s*[〜～~\-–—]\s*.+$/);
        if (m) { s = m[1].trim(); } // 範囲表記は開始側で判定
        if (/^\d{1,2}:\d{1,2}:\d{1,2}[,.]\d{1,3}$/.test(s)) { return true; } // SRT形式
        if (/^\d{1,2}([;:]\d{1,2}){1,3}$/.test(s)) { return true; }          // ;/: 区切り
        return false;
    }

    // Markdown表の1行を分類（fps: フレーム範囲検証用・任意）:
    //   {status:'record', row:{tcRaw,cur,fix}} … 採用（修正マーカー1件）
    //   {status:'error',  reason}              … TC行らしいが採用不能（列数不一致/修正案空/TC判別不能）→ 呼び出し側で errs へ
    //   {status:'ignore'}                       … 対象外（ヘッダ・区切り・技術チェック表・表以外）
    // 期待列数（3列型=3 / 6列型=6）に一致しない行は error にする（K2-6: 余分/不足の列ズレ誤採用を防ぐ）。
    function classifyMdRow(line, fps) {
        var t = String(line).trim();
        if (t.charAt(0) !== '|') { return { status: 'ignore' }; }
        var cells = splitMdCells(t);
        for (var i = 0; i < cells.length; i++) { cells[i] = cleanCell(cells[i]); }
        if (!cells.length || /^:?-{2,}:?$/.test(cells[0])) { return { status: 'ignore' }; } // 区切り行

        // 3列型: | TC | 該当 | 修正案 |（ちょうど3列）
        if (parseTCCell(cells[0], fps)) {
            if (cells.length !== 3) {
                return { status: 'error', reason: '列数不一致（3列型なのに' + cells.length + '列）' };
            }
            if (!cells[2]) { return { status: 'error', reason: '修正案が空' }; }
            return { status: 'record', row: { tcRaw: cells[0], cur: cells[1], fix: cells[2] } };
        }
        // 6列型: | # | TC | 該当 | 修正案 | 理由 | 重要度 |（ちょうど6列）
        if (/^\d+$/.test(cells[0]) && cells.length >= 2 && parseTCCell(cells[1], fps)) {
            if (cells.length !== 6) {
                return { status: 'error', reason: '列数不一致（6列型なのに' + cells.length + '列）' };
            }
            if (!cells[3]) { return { status: 'error', reason: '修正案が空' }; }
            return { status: 'record', row: { tcRaw: cells[1], cur: cells[2], fix: cells[3] } };
        }
        // TCらしきセルがあるのに上のどれにも当てはまらない＝黙ってスキップせずエラーとして表面化
        if (looksLikeTC(cells[0]) || (cells.length >= 2 && looksLikeTC(cells[1]))) {
            return { status: 'error', reason: 'TC判別不能または列構成不正' };
        }
        return { status: 'ignore' };
    }

    // 後方互換: 採用行なら {tcRaw,cur,fix}、それ以外（対象外・エラー）は null
    function parseMdRow(line, fps) {
        var c = classifyMdRow(line, fps);
        return c.status === 'record' ? c.row : null;
    }

    // テキスト全体 → {list:[{tc, tcRaw, cur, fix}], errs:[]}
    // opts.tableOnly=true: Markdown表の行だけを対象（添削指示書ファイル読込用。地の文を無視）
    // opts.fps: 公称fps。渡すとフレーム値の範囲検証（ff<fps）も行い、範囲外行を errs に載せる（K2-7）
    function parseText(text, opts) {
        opts = opts || {};
        var fps = opts.fps;
        var lines = String(text).split(/\r?\n/);
        var records = []; // {tcRaw, fields:[]}
        var errs = [];
        var cur = null;
        var mdTcRows = 0, mdAdopted = 0; // 表のTC付き行数 / うち採用できた件数（見逃し検知用）
        for (var i = 0; i < lines.length; i++) {
            var raw = lines[i];
            var t = raw.trim();
            if (!t) { continue; }

            if (t.charAt(0) === '|') {
                var cls = classifyMdRow(raw, fps);
                if (cls.status === 'record') {
                    mdTcRows++; mdAdopted++;
                    records.push({ tcRaw: cls.row.tcRaw, fields: cls.row.cur ? [cls.row.cur, cls.row.fix] : [cls.row.fix] });
                    cur = null;
                    continue;
                }
                if (cls.status === 'error') {
                    mdTcRows++;
                    errs.push((i + 1) + '行目: 表のTC付き行だが採用不可（' + cls.reason + '）「' + t + '」');
                    cur = null;
                    continue;
                }
                continue; // ヘッダ・区切り・技術チェック表など対象外
            }
            if (opts.tableOnly) { continue; }      // ファイル読込時は表以外の行を無視
            if (t.indexOf('タイムコード') !== -1) { continue; } // ヘッダ行

            // タブ区切りの1行完結レコード
            if (raw.indexOf('\t') !== -1) {
                var cols = raw.split('\t');
                if (parseTCCell(cols[0] || '', fps)) {
                    var f = [];
                    for (var c = 1; c < cols.length; c++) { if (cols[c].trim()) { f.push(cols[c].trim()); } }
                    records.push({ tcRaw: cols[0].trim(), fields: f });
                    cur = null;
                    continue;
                }
            }

            // 縦並び: TC行 → 新レコード開始
            if (parseTCCell(t, fps)) {
                cur = { tcRaw: t, fields: [] };
                records.push(cur);
                continue;
            }

            // タブ喪失コピペ対策: 「TC＋空白＋本文」の1行完結レコード
            // （Slack等を経由するとタブが半角空白になることがある。現在/修正の区切りは
            //   タブ・2連以上の半角空白・全角空白のみ＝本文中の単発半角空白では分割しない）
            var spm = t.match(/^(\S+)[ \t　]+(\S[\s\S]*)$/);
            if (spm && parseTCCell(spm[1], fps)) {
                var rest2 = spm[2].trim();
                var parts2 = rest2.split(/\t+|[ ]{2,}|　+/);
                var pf = [];
                for (var q = 0; q < parts2.length; q++) { if (parts2[q].trim()) { pf.push(parts2[q].trim()); } }
                records.push({ tcRaw: spm[1], fields: pf });
                cur = null;
                continue;
            }

            if (cur) {
                cur.fields.push(t);
            } else {
                errs.push((i + 1) + '行目: TC前の孤立テキスト「' + t + '」');
            }
        }

        var out = [];
        for (var r = 0; r < records.length; r++) {
            var rec = records[r];
            var curText = '', fixText = '';
            if (rec.fields.length >= 2) { curText = rec.fields[0]; fixText = rec.fields.slice(1).join(' '); }
            else if (rec.fields.length === 1) { fixText = rec.fields[0]; }
            else { errs.push(rec.tcRaw + ': 本文なし（スキップ）'); continue; }
            out.push({ tc: parseTCCell(rec.tcRaw, fps), tcRaw: rec.tcRaw, cur: curText, fix: fixText });
        }
        return { list: out, errs: errs, stats: { mdTcRows: mdTcRows, mdAdopted: mdAdopted } };
    }

    // ゼロ幅一意ID コーデック（K2-2 / K3-4 / K3-5 / K3-6）。この拡張が付けたマーカーを「完全不可視」に識別する。
    // 規則（hostscript.jsx の _encodeId/_decodeId と厳密に一致させること）。詳細は ↓ の KMID_SIG 付近を参照。
    //   FRAME='⁠'(WORD JOINER) / 0bit='​'(ZWSP) / 1bit='‌'(ZWNJ) … いずれも表示幅ゼロ。
    //   各数値は2進(MSB先頭・正準)で符号化。ビット演算は32bit幅で溢れるため、復号は乗算で行い 2^53 まで正確。
    var KMID_ZERO = '\u200B', KMID_ONE = '\u200C', KMID_FRAME = '\u2060';

    // ↑ タグ構造（K3-4/K3-5）: FRAME + SIG + FRAME + runIdBits + FRAME + kBits + FRAME + checksumBits + FRAME
    // 所有判定は「センチネル構造＋シグネチャ一致＋チェックサム検証OK＋正準表現」を必須にする（形だけ一致は非所有）。
    // recordId は (runId, k) を別フィールドで符号化（runId*1000+k の衝突を排除）。復号値は正準文字列 "runId:k"。
    var KMID_SIG = '11001010111100001101'; // 名前空間シグネチャ（hostscript.jsx と厳密一致・変更時は両方＋テスト同期）
    var KMID_CKP = 1000003;                 // チェックサム法（素数・積が 2^53 未満に収まるよう選定）

    // 「空でない安全な非負整数」だけ受理し数値を返す。それ以外（空/符号/小数/非数字/2^53超）は null（K3-6）。
    // 空文字は Number('')===0 になる罠があるため、この境界チェックを必ず通す。
    function safeNonNegInt(s) {
        if (s === null || s === undefined) { return null; }
        var t = String(s);
        if (!/^\d+$/.test(t)) { return null; }
        var n = parseInt(t, 10);
        if (!isFinite(n) || n < 0) { return null; }
        if (n > 9007199254740991) { return null; } // 2^53-1 超は非受理
        return n;
    }

    function _numToBits(n) { // 正準2進（MSB先頭・先頭ゼロなし。0 は '0'）
        if (n === 0) { return '0'; }
        var bits = '', x = n;
        while (x > 0) { bits = (x % 2) + bits; x = Math.floor(x / 2); }
        return bits;
    }
    function _bitsToNum(bits) {
        var val = 0;
        for (var j = 0; j < bits.length; j++) { val = val * 2 + (bits.charAt(j) === '1' ? 1 : 0); }
        return val;
    }
    function _zwFromBits(bits) { // '0'/'1' 列 → ゼロ幅列
        var out = '';
        for (var i = 0; i < bits.length; i++) { out += (bits.charAt(i) === '1') ? KMID_ONE : KMID_ZERO; }
        return out;
    }
    function _zwToBits(part) { // ゼロ幅列 → '0'/'1' 列。0/1以外の文字が混じれば null
        var b = '';
        for (var i = 0; i < part.length; i++) {
            var c = part.charAt(i);
            if (c === KMID_ZERO) { b += '0'; }
            else if (c === KMID_ONE) { b += '1'; }
            else { return null; }
        }
        return b;
    }
    function _isZW(ch) { return ch === KMID_ZERO || ch === KMID_ONE || ch === KMID_FRAME; }
    function _nonCanonical(b) { return b.length > 1 && b.charAt(0) === '0'; } // 先頭ゼロ埋めは非正準
    function _checksum(runId, k) {
        var a = runId % KMID_CKP; if (a < 0) { a += KMID_CKP; }
        var b = k % KMID_CKP; if (b < 0) { b += KMID_CKP; }
        return (a * 31 + b * 17 + 12345) % KMID_CKP;
    }
    function makeRid(runId, k) { return String(runId) + ':' + String(k); } // 正準ID文字列

    // (runId, k) をゼロ幅タグに符号化。不正値（Infinity/NaN/負数/非整数/空）は例外（K3-6: 無限ループ・破損防止）。
    function encodeId(runId, k) {
        var r = safeNonNegInt(runId), n = safeNonNegInt(k);
        if (r === null || n === null) { throw new Error('encodeId: 不正なID (' + runId + ',' + k + ')'); }
        var cs = _checksum(r, n);
        return KMID_FRAME + _zwFromBits(KMID_SIG) + KMID_FRAME +
            _zwFromBits(_numToBits(r)) + KMID_FRAME +
            _zwFromBits(_numToBits(n)) + KMID_FRAME +
            _zwFromBits(_numToBits(cs)) + KMID_FRAME;
    }

    // name 末尾のゼロ幅タグを厳密検証。所有なら {id:"runId:k", textLen:タグ開始位置}、非所有は null。
    function _parseTag(name) {
        name = String(name);
        var L = name.length;
        if (L < 2 || name.charAt(L - 1) !== KMID_FRAME) { return null; }
        // 末尾の最大ゼロ幅ランを切り出す（通常の名前にゼロ幅文字は無い＝ラン全体がタグ）
        var i = L - 1;
        while (i >= 0 && _isZW(name.charAt(i))) { i--; }
        var start = i + 1;
        var parts = name.slice(start).split(KMID_FRAME);
        // 構造: FRAME f1 FRAME f2 FRAME f3 FRAME f4 FRAME → split で ['',f1,f2,f3,f4,'']（長さ6）
        if (parts.length !== 6 || parts[0] !== '' || parts[5] !== '') { return null; }
        var sigB = _zwToBits(parts[1]);
        if (sigB === null || sigB !== KMID_SIG) { return null; } // シグネチャ不一致（K3-4）
        var rB = _zwToBits(parts[2]), kB = _zwToBits(parts[3]), cB = _zwToBits(parts[4]);
        if (rB === null || kB === null || cB === null) { return null; }
        if (!rB.length || !kB.length || !cB.length) { return null; }
        if (_nonCanonical(rB) || _nonCanonical(kB) || _nonCanonical(cB)) { return null; } // 非正準は拒否（K3-4）
        var runId = _bitsToNum(rB), k = _bitsToNum(kB), cs = _bitsToNum(cB);
        // K4-4: 復号値は安全整数上限（2^53-1）以下でなければ非所有。超えると _bitsToNum が丸め、
        // 以後の照合・再符号化・チェックサムが破綻する（別マーカーと誤一致しうる）。
        if (runId > 9007199254740991 || k > 9007199254740991 || cs > 9007199254740991) { return null; }
        // K4-4: 復号値を再エンコードして元のビット列と完全一致（正準）することを確認。
        // 先頭ゼロ埋め（_nonCanonical で既に排除）に加え、2^53超で丸めた値がビット列と食い違う細工も弾く。
        if (_numToBits(runId) !== rB || _numToBits(k) !== kB || _numToBits(cs) !== cB) { return null; }
        if (cs !== _checksum(runId, k)) { return null; } // チェックサム不一致（K3-4）
        return { id: makeRid(runId, k), textLen: start };
    }

    function decodeId(name) { var t = _parseTag(name); return t ? t.id : null; }

    // 表示用: 末尾のゼロ幅IDタグを除去（無ければそのまま）
    function stripId(name) { var t = _parseTag(name); return t ? String(name).slice(0, t.textLen) : String(name); }

    function isOwned(name) { return _parseTag(name) !== null; }

    var KMParser = { parseTC: parseTC, parseTCCell: parseTCCell, tcToFrame: tcToFrame, parseMdRow: parseMdRow, classifyMdRow: classifyMdRow, looksLikeTC: looksLikeTC, parseText: parseText, encodeId: encodeId, decodeId: decodeId, stripId: stripId, isOwned: isOwned, safeNonNegInt: safeNonNegInt, makeRid: makeRid };
    if (typeof module !== 'undefined' && module.exports) { module.exports = KMParser; }
    root.KMParser = KMParser;
})(typeof window !== 'undefined' ? window : this);
