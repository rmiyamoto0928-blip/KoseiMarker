// 校正マーカー 入力パーサー（UI非依存。node でテスト可能）
// 対応形式:
//   1) 縦並び（TC行 → 現在 → 修正案）
//   2) タブ区切り（TC[Tab]現在[Tab]修正案）
//   3) Markdown表 3列（typo-check統合レポート: | TC | 該当テキスト | 修正案 |）
//   4) Markdown表 6列（添削指示書: | # | TC | 該当テキスト | 修正案 | 理由 | 重要度 |）
// タイムコード:
//   HH;MM;SS;FF / HH:MM:SS:FF（フレーム精度） / MM:SS・HH:MM:SS（秒精度）
//   HH:MM:SS,mmm / HH:MM:SS.mmm（SRT・ミリ秒精度）
(function (root) {
    'use strict';

    // TC文字列を解析。成功: {kind:'frames'|'ms', hh,mm,ss, ff|ms, precise, raw} ／ 失敗: null
    // precise=false は「秒までしか分からないTC」（微調整プリセットの適用対象）
    function parseTC(s) {
        s = String(s).trim();
        var m = s.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/); // SRT形式
        if (m) {
            var ms = parseInt((m[4] + '00').slice(0, 3), 10);
            return { kind: 'ms', hh: +m[1], mm: +m[2], ss: +m[3], ms: ms, precise: true, raw: s };
        }
        if (!/^\d{1,2}([;:]\d{1,2}){1,3}$/.test(s)) { return null; }
        var p = s.split(/[;:]/);
        for (var i = 0; i < p.length; i++) { p[i] = parseInt(p[i], 10); }
        var hh, mm, ss, ff, precise;
        if (p.length === 2 && s.indexOf(';') !== -1) { return null; } // 「05;10」はMM;SSかSS;FFか判別不能
        if (p.length === 2) { hh = 0; mm = p[0]; ss = p[1]; ff = 0; precise = false; }
        else if (p.length === 3) { hh = p[0]; mm = p[1]; ss = p[2]; ff = 0; precise = false; }
        else { hh = p[0]; mm = p[1]; ss = p[2]; ff = p[3]; precise = true; }
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

    function cleanCell(s) {
        return String(s).replace(/<br\s*\/?>/gi, ' ').replace(/\*\*/g, '').trim();
    }

    // Markdown表の1行 → {tcRaw, cur, fix} ／ 対象外（ヘッダ・区切り・技術チェック表等）は null
    function parseMdRow(line) {
        var t = String(line).trim();
        if (t.charAt(0) !== '|') { return null; }
        var cells = t.replace(/^\|/, '').replace(/\|+$/, '').split('|');
        for (var i = 0; i < cells.length; i++) { cells[i] = cleanCell(cells[i]); }
        if (!cells.length || /^:?-{2,}:?$/.test(cells[0])) { return null; } // 区切り行
        // 3列型: | TC | 該当 | 修正案 |
        if (parseTC(cells[0])) {
            if (cells.length < 3 || !cells[2]) { return null; }
            return { tcRaw: cells[0], cur: cells[1], fix: cells[2] };
        }
        // 6列型: | # | TC | 該当 | 修正案 | 理由 | 重要度 |
        if (/^\d+$/.test(cells[0]) && cells.length >= 4 && parseTC(cells[1]) && cells[3]) {
            return { tcRaw: cells[1], cur: cells[2], fix: cells[3] };
        }
        return null;
    }

    // テキスト全体 → {list:[{tc, tcRaw, cur, fix}], errs:[]}
    // opts.tableOnly=true: Markdown表の行だけを対象（添削指示書ファイル読込用。地の文を無視）
    function parseText(text, opts) {
        opts = opts || {};
        var lines = String(text).split(/\r?\n/);
        var records = []; // {tcRaw, fields:[]}
        var errs = [];
        var cur = null;
        for (var i = 0; i < lines.length; i++) {
            var raw = lines[i];
            var t = raw.trim();
            if (!t) { continue; }

            var md = parseMdRow(raw);
            if (md) {
                records.push({ tcRaw: md.tcRaw, fields: md.cur ? [md.cur, md.fix] : [md.fix] });
                cur = null;
                continue;
            }
            if (t.charAt(0) === '|') { continue; } // 表のヘッダ行・技術チェック表など
            if (opts.tableOnly) { continue; }      // ファイル読込時は表以外の行を無視
            if (t.indexOf('タイムコード') !== -1) { continue; } // ヘッダ行

            // タブ区切りの1行完結レコード
            if (raw.indexOf('\t') !== -1) {
                var cols = raw.split('\t');
                if (parseTC(cols[0] || '')) {
                    var f = [];
                    for (var c = 1; c < cols.length; c++) { if (cols[c].trim()) { f.push(cols[c].trim()); } }
                    records.push({ tcRaw: cols[0].trim(), fields: f });
                    cur = null;
                    continue;
                }
            }

            // 縦並び: TC行 → 新レコード開始
            if (parseTC(t)) {
                cur = { tcRaw: t, fields: [] };
                records.push(cur);
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
            out.push({ tc: parseTC(rec.tcRaw), tcRaw: rec.tcRaw, cur: curText, fix: fixText });
        }
        return { list: out, errs: errs };
    }

    var KMParser = { parseTC: parseTC, tcToFrame: tcToFrame, parseMdRow: parseMdRow, parseText: parseText };
    if (typeof module !== 'undefined' && module.exports) { module.exports = KMParser; }
    root.KMParser = KMParser;
})(typeof window !== 'undefined' ? window : this);
