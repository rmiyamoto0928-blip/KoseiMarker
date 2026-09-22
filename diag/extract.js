// ============================================================================
// KoseiMarker / テキスト抽出＋Adobe書き出し比較（開発・調査専用 / UI非依存・node でテスト可能）
//
//  1) extract()        … diag/textdiag.jsx が出した診断JSON から「本文候補」を取り出し、
//                        STEP9 で提案する内部データ構造（JSON）に整える。
//  2) parseAdobeCsv()  … Premiere「テキスト → グラフィック → 書き出し」のCSVを読む。
//  3) compare()        … Adobe公式出力 と 抽出結果 を突き合わせ、一致率／取得漏れ／余分を出す。
//
// ※ 本番の校正マーカー処理（js/parser.js, js/main.js, js/hostscript.jsx）からは完全に独立。
//    ここは「取得方法が確立できるか」を測るための計測器であり、まだ本番には接続しない。
//
// 設計方針（重要）:
//   実機データを見る前に「本文はこのキーにある」と決め打ちしない。候補は必ず
//   provenance（どのcomponent／どのparam／どの呼び出しから来たか）と confidence を付けて出し、
//   採らなかったものは rejected に理由付きで残す。判断材料を捨てない。
// ============================================================================
(function (root) {
    'use strict';

    // ---------------------------------------------------------------- 文字列ユーティリティ
    function nfc(s) {
        var t = String(s === null || s === undefined ? '' : s);
        return t.normalize ? t.normalize('NFC') : t;
    }

    // 比較用の正規化。改行の差・前後空白・連続空白・全角半角空白の差を吸収する。
    // opts.keepNewlines=true なら改行を \n に統一して保持（改行の一致も見たいとき）。
    function normalizeForCompare(s, opts) {
        opts = opts || {};
        var t = nfc(s);
        t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        t = t.replace(/　/g, ' ');           // 全角空白 → 半角
        t = t.replace(/[​‌⁠﻿]/g, ''); // ゼロ幅系は除去（校正マーカーのIDタグ等）
        if (opts.keepNewlines) {
            t = t.replace(/[ \t]+/g, ' ');
            t = t.replace(/[ \t]*\n[ \t]*/g, '\n');
        } else {
            t = t.replace(/\s+/g, ' ');
        }
        return t.replace(/^\s+/, '').replace(/\s+$/, '');
    }

    // 「本文らしいか」の保守的な判定。決め打ちで捨てないよう、落とす理由を返す形にする。
    //   戻り値: null=本文らしい / string=落とす理由
    function rejectReason(s) {
        var t = nfc(s);
        if (!t.length) { return '空文字'; }
        if (!/\S/.test(t)) { return '空白のみ'; }
        // 内部識別子っぽいもの（matchName など）
        if (/^(AE|ADBE|PPro)[.\s]/i.test(t) || /\bADBE\b/.test(t)) { return '内部識別子らしい（ADBE/AE.）'; }
        // 数値・真偽値だけ
        if (/^[-+]?[0-9]+(\.[0-9]+)?$/.test(t)) { return '数値のみ'; }
        if (/^(true|false)$/i.test(t)) { return '真偽値のみ'; }
        // 座標・カラーの文字列表現
        if (/^\[?\s*[-+0-9.,\s]+\]?$/.test(t)) { return '数値列のみ（座標/色の可能性）'; }
        return null;
    }

    // 本文候補キーの優先度（高いほど本文として確度が高い）。
    // コミュニティ報告のあるキー名を上位に置くが、未知のキーも /text/i なら候補として残す。
    var KEY_PRIORITY = ['texteditvalue', 'mrawtext', 'rawtext', 'sourcetext', 'mtext', 'text'];
    function keyRank(k) {
        var lk = String(k).toLowerCase();
        for (var i = 0; i < KEY_PRIORITY.length; i++) {
            if (lk === KEY_PRIORITY[i]) { return i; }
        }
        return KEY_PRIORITY.length; // 未知の text 系キーは最後
    }

    // ---------------------------------------------------------------- 診断JSON の読み取り補助
    // textdiag.jsx の kmdValueJson が作る {call,ok,type,value,...} を安全に読む
    function callValue(call) {
        if (!call || call.ok !== true) { return undefined; }
        return call.value;
    }
    function findCall(calls, name) {
        if (!calls) { return null; }
        for (var i = 0; i < calls.length; i++) {
            if (calls[i] && calls[i].call === name) { return calls[i]; }
        }
        return null;
    }
    // 属性（textdiag では属性も kmdValueJson で包んである）の素の値
    function attr(node) {
        if (node === null || node === undefined) { return undefined; }
        if (typeof node === 'object' && 'ok' in node) { return callValue(node); }
        return node;
    }

    // ---------------------------------------------------------------- param → 本文候補
    // 1つの ComponentParam から本文候補を全部出す（複数キーが在り得るので配列）。
    function candidatesFromParam(param, where) {
        var out = [];
        var rejected = [];
        if (!param) { return { texts: out, rejected: rejected }; }

        var paramName = param.displayName || param.name || null;
        var calls = param.calls || [];
        // getValue() を優先し、取れなければ getValueAtTime(0) を見る
        var order = ['getValue()', 'getValueAtTime(0)'];

        for (var oi = 0; oi < order.length; oi++) {
            var call = findCall(calls, order[oi]);
            if (!call) { continue; }
            if (call.ok !== true) {
                rejected.push({ where: where, via: order[oi], reason: '呼び出し失敗: ' + (call.error || '不明'), param: paramName });
                continue;
            }
            if (call.omitted) {
                rejected.push({ where: where, via: order[oi], reason: '省略(' + call.omitted + ')', param: paramName });
                continue;
            }
            if (call.type !== 'string') {
                rejected.push({ where: where, via: order[oi], reason: '型が string でない(' + call.type + ')', param: paramName });
                continue;
            }

            // JSON で来ている場合は text 系キーを優先度順に採る
            if (call.jsonTextKeys && call.jsonTextKeys.length) {
                var keys = call.jsonTextKeys.slice().sort(function (a, b) { return keyRank(a.key) - keyRank(b.key); });
                for (var k = 0; k < keys.length; k++) {
                    var rr = rejectReason(keys[k].value);
                    if (rr) {
                        rejected.push({ where: where, via: order[oi] + ' json:' + keys[k].key, reason: rr, param: paramName });
                        continue;
                    }
                    out.push({
                        text: nfc(keys[k].value),
                        via: order[oi] + ' → json key "' + keys[k].key + '"',
                        paramDisplayName: paramName,
                        paramIndex: (param.index === undefined ? null : param.index),
                        truncated: !!(keys[k].truncated || call.truncated),
                        confidence: (keyRank(keys[k].key) < KEY_PRIORITY.length ? 'high' : 'medium')
                    });
                }
                if (out.length) { break; } // このparamの本文は取れた
                continue;
            }
            // （素の string の場合はこの下で1件だけ push する）

            // 素の string
            if (call.looksJson) {
                rejected.push({ where: where, via: order[oi], reason: 'JSONらしいが text 系キーが見つからない', param: paramName });
                continue;
            }
            var r2 = rejectReason(call.value);
            if (r2) {
                rejected.push({ where: where, via: order[oi], reason: r2, param: paramName });
                continue;
            }
            out.push({
                text: nfc(call.value),
                via: order[oi],
                paramDisplayName: paramName,
                paramIndex: (param.index === undefined ? null : param.index),
                truncated: !!call.truncated,
                confidence: 'high'
            });
            break;
        }
        // 同じ param から複数の本文候補が出た場合（JSON内に text 系キーが複数ある等）、
        // 優先度が最も高い1件だけを primary にする。件数を数えるとき（一致率）は primary だけを使い、
        // それ以外も捨てずに残す＝実機データを見てから判断できるようにする。
        for (var pi = 0; pi < out.length; pi++) { out[pi].primary = (pi === 0); }
        return { texts: out, rejected: rejected };
    }

    // ---------------------------------------------------------------- component → 本文候補
    function candidatesFromComponent(comp, where) {
        var texts = [], rejected = [];
        if (!comp) { return { texts: texts, rejected: rejected }; }
        var cWhere = where + ' / ' + (comp.matchName || comp.displayName || 'component');

        // 素の index 走査（言語非依存。これを主経路にする）
        var params = comp.params || [];
        for (var i = 0; i < params.length; i++) {
            var r = candidatesFromParam(params[i], cWhere);
            for (var t = 0; t < r.texts.length; t++) {
                r.texts[t].componentMatchName = comp.matchName || null;
                r.texts[t].componentDisplayName = comp.displayName || null;
                texts.push(r.texts[t]);
            }
            rejected = rejected.concat(r.rejected);
        }

        // getParamForDisplayName の結果も拾う（index走査で漏れた場合の保険。重複は後段で除去）
        var bd = comp.byDisplayName || [];
        for (var b = 0; b < bd.length; b++) {
            if (!bd[b] || bd[b].found !== true || !bd[b].param) { continue; }
            var rb = candidatesFromParam(bd[b].param, cWhere + ' / getParamForDisplayName("' + bd[b].displayName + '")');
            for (var tb = 0; tb < rb.texts.length; tb++) {
                rb.texts[tb].componentMatchName = comp.matchName || null;
                rb.texts[tb].componentDisplayName = comp.displayName || null;
                rb.texts[tb].viaDisplayNameLookup = bd[b].displayName;
                texts.push(rb.texts[tb]);
            }
        }
        return { texts: texts, rejected: rejected };
    }

    // ---------------------------------------------------------------- メイン: 診断JSON → 内部データ構造
    // 戻り値は STEP9 で提案する形（sequence / graphics[] / texts[]）＋ 診断メタ。
    function extract(report) {
        if (!report || report.schema !== 'koseimarker.textdiag/1') {
            return { error: '診断レポートの形式が違います（schema=koseimarker.textdiag/1 が必要）' };
        }
        var seq = report.sequence || {};
        var out = {
            schema: 'koseimarker.graphics/1',
            sequence: {
                name: attr(seq.name) || null,
                sequenceId: attr(seq.sequenceID) || null,
                fps: (seq.fps === undefined ? null : seq.fps),
                timebase: attr(seq.timebase) || null,
                zeroPointTicks: attr(seq.zeroPoint) || null,
                videoDisplayFormat: attr(seq.videoDisplayFormat) || null
            },
            graphics: [],
            rejected: [],
            diagnostics: {
                valueMode: report.valueMode || null,
                hostLocale: attr((report.host || {}).locale) || null,
                appVersion: attr((report.host || {}).appVersion) || null,
                truncated: !!report.truncated,
                scannedClips: (report.stats || {}).scannedClips || 0,
                totalClips: (report.stats || {}).totalClips || 0,
                clipsWithText: 0,
                textCount: 0,
                nestedSequenceClips: 0,
                disabledClipsWithText: 0,
                errors: (report.errors || []).slice()
            }
        };

        var tracks = report.tracks || [];
        for (var ti = 0; ti < tracks.length; ti++) {
            var clips = tracks[ti].clips || [];
            for (var ci = 0; ci < clips.length; ci++) {
                var clip = clips[ci];
                var where = (tracks[ti].label || ('V' + (ti + 1))) + ' / clip[' + ci + ']';
                var texts = [], rej = [];

                // MOGRT（AE製 .mogrt の公開パラメータ）
                var mgt = clip.mgt || {};
                var kind = 'unknown';
                if (mgt.available === true && mgt.component) {
                    var rm = candidatesFromComponent(mgt.component, where + ' / getMGTComponent()');
                    for (var m = 0; m < rm.texts.length; m++) { rm.texts[m].origin = 'mgt'; texts.push(rm.texts[m]); }
                    rej = rej.concat(rm.rejected);
                    if (rm.texts.length) { kind = 'mogrt'; }
                }

                // 通常の components（Premiere ネイティブグラフィック等）
                var comps = clip.components || [];
                for (var k = 0; k < comps.length; k++) {
                    var rc = candidatesFromComponent(comps[k], where);
                    for (var n = 0; n < rc.texts.length; n++) { rc.texts[n].origin = 'component'; texts.push(rc.texts[n]); }
                    rej = rej.concat(rc.rejected);
                }
                if (kind === 'unknown' && texts.length) { kind = 'premiereGraphic'; }

                // 重複除去（同じ本文が index走査 と displayName引き の両方で出る）
                texts = dedupeTexts(texts);

                var pi = clip.projectItem || {};
                var isNested = attr(pi.isSequence) === true;
                var disabled = attr(clip.disabled) === true;
                if (isNested) { out.diagnostics.nestedSequenceClips++; }

                // 本文が1件も無いクリップは graphics に載せない（rejected 側に理由が残る）
                if (!texts.length) {
                    out.rejected = out.rejected.concat(rej);
                    continue;
                }

                out.diagnostics.clipsWithText++;
                out.diagnostics.textCount += texts.length;
                if (disabled) { out.diagnostics.disabledClipsWithText++; }

                var st = clip.start || {}, en = clip.end || {};
                out.graphics.push({
                    trackIndex: (clip.trackIndex === undefined ? ti : clip.trackIndex),
                    trackLabel: tracks[ti].label || ('V' + (ti + 1)),
                    clipIndex: (clip.clipIndex === undefined ? ci : clip.clipIndex),
                    clipName: clip.name || null,
                    matchName: attr(clip.matchName) || attr(clip.matchNameAttr) || null,
                    type: kind,
                    disabled: disabled,
                    isNestedSequence: isNested,
                    projectItemName: attr(pi.name) || null,
                    start: { ticks: st.ticks === undefined ? null : st.ticks, seconds: st.seconds === undefined ? null : st.seconds },
                    end: { ticks: en.ticks === undefined ? null : en.ticks, seconds: en.seconds === undefined ? null : en.seconds },
                    texts: texts
                });
                out.rejected = out.rejected.concat(rej);
            }
        }
        // 時間順（Adobe書き出しと並びを揃えて比較しやすくする）
        out.graphics.sort(function (a, b) {
            var as = (a.start && isFinite(a.start.seconds)) ? a.start.seconds : 0;
            var bs = (b.start && isFinite(b.start.seconds)) ? b.start.seconds : 0;
            if (as !== bs) { return as - bs; }
            return a.trackIndex - b.trackIndex;
        });
        return out;
    }

    // 同一クリップ内で本文が完全一致するものを1件に畳む（provenance は残す）
    function dedupeTexts(texts) {
        var seen = {}, out = [];
        for (var i = 0; i < texts.length; i++) {
            var key = normalizeForCompare(texts[i].text, { keepNewlines: true });
            if (seen[key] !== undefined) {
                var prev = out[seen[key]];
                if (!prev.alsoVia) { prev.alsoVia = []; }
                prev.alsoVia.push(texts[i].via);
                continue;
            }
            seen[key] = out.length;
            out.push(texts[i]);
        }
        return out;
    }

    // ---------------------------------------------------------------- CSV パーサ（RFC4180準拠）
    // 引用符内のカンマ・改行・"" エスケープを正しく扱う。BOM/CRLF も吸収する。
    function parseCsv(text) {
        var s = String(text === null || text === undefined ? '' : text);
        if (s.charAt(0) === '﻿') { s = s.slice(1); } // BOM
        var rows = [], row = [], field = '', inQuotes = false;
        var i = 0;
        while (i < s.length) {
            var c = s.charAt(i);
            if (inQuotes) {
                if (c === '"') {
                    if (s.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
                    inQuotes = false; i++; continue;
                }
                field += c; i++; continue;
            }
            if (c === '"') { inQuotes = true; i++; continue; }
            if (c === ',') { row.push(field); field = ''; i++; continue; }
            if (c === '\r') {
                if (s.charAt(i + 1) === '\n') { i++; }
                row.push(field); field = ''; rows.push(row); row = []; i++; continue;
            }
            if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; i++; continue; }
            field += c; i++;
        }
        // 最終行（末尾改行が無い場合）
        if (field.length || row.length) { row.push(field); rows.push(row); }
        // 完全に空の行は落とす
        var out = [];
        for (var r = 0; r < rows.length; r++) {
            var allEmpty = true;
            for (var q = 0; q < rows[r].length; q++) { if (rows[r][q] !== '') { allEmpty = false; break; } }
            if (!allEmpty) { out.push(rows[r]); }
        }
        return { rows: out, unterminatedQuote: inQuotes };
    }

    // 列名のエイリアス（Premiere のUI言語でヘッダが変わるため両方持つ）。
    // ヘッダが読めない場合は「位置（Start, End, Text, Video Track, Layer ID）」にフォールバックする。
    var CSV_ALIASES = {
        start: ['start time', 'start', 'in', '開始時間', '開始', 'イン点', '開始タイムコード'],
        end: ['end time', 'end', 'out', '終了時間', '終了', 'アウト点', '終了タイムコード'],
        text: ['text', 'テキスト', '本文'],
        track: ['video track', 'track', 'ビデオトラック', 'トラック'],
        layer: ['layer id', 'layer', 'レイヤーid', 'レイヤー', 'レイヤー id']
    };
    function matchHeader(cell) {
        var c = normalizeForCompare(cell).toLowerCase();
        if (!c) { return null; }
        for (var key in CSV_ALIASES) {
            if (!Object.prototype.hasOwnProperty.call(CSV_ALIASES, key)) { continue; }
            var list = CSV_ALIASES[key];
            for (var i = 0; i < list.length; i++) {
                if (c === list[i]) { return key; }
            }
        }
        return null;
    }

    // Premiere「テキスト → グラフィック → CSV書き出し」を読む。
    //   戻り値: { rows:[{start,end,text,track,layer,raw}], header:{...}, headerDetected:bool, warnings:[] }
    function parseAdobeCsv(text) {
        var p = parseCsv(text);
        var warnings = [];
        if (p.unterminatedQuote) { warnings.push('引用符が閉じていないCSVです（末尾が壊れている可能性）'); }
        if (!p.rows.length) { return { rows: [], header: null, headerDetected: false, warnings: ['CSVが空です'] }; }

        // ヘッダ検出
        var first = p.rows[0];
        var map = {}, hits = 0;
        for (var i = 0; i < first.length; i++) {
            var key = matchHeader(first[i]);
            if (key !== null && map[key] === undefined) { map[key] = i; hits++; }
        }
        var headerDetected = hits >= 2; // 2列以上一致したらヘッダ行とみなす
        var dataStart = headerDetected ? 1 : 0;
        if (!headerDetected) {
            // 位置フォールバック（Adobe の既定列順）
            map = { start: 0, end: 1, text: 2, track: 3, layer: 4 };
            warnings.push('ヘッダを判別できなかったため列順（Start, End, Text, Video Track, Layer ID）で読みました');
        } else if (map.text === undefined) {
            warnings.push('テキスト列のヘッダを判別できませんでした。3列目をテキストとして読みます');
            map.text = 2;
        }

        var rows = [];
        for (var r = dataStart; r < p.rows.length; r++) {
            var cells = p.rows[r];
            function cell(k) {
                var idx = map[k];
                if (idx === undefined || idx >= cells.length) { return ''; }
                return cells[idx];
            }
            var t = cell('text');
            if (!nfc(t).replace(/\s+/g, '').length) { continue; } // テキストが空の行はスキップ
            rows.push({
                rowNumber: r + 1,
                start: nfc(cell('start')),
                end: nfc(cell('end')),
                text: nfc(t),
                track: nfc(cell('track')),
                layer: nfc(cell('layer')),
                raw: cells
            });
        }
        return { rows: rows, header: map, headerDetected: headerDetected, warnings: warnings };
    }

    // ---------------------------------------------------------------- 比較（STEP6）
    // Adobe公式出力を正 とし、抽出結果が何％取れているかを出す。
    //   opts.keepNewlines=true … 改行の一致も見る（既定 true）
    //   opts.primaryOnly=true  … 1つの param から複数候補が出た場合は primary だけを数える（既定 true）
    // 多重集合で突き合わせる（同じ文字列が複数あっても件数まで合わせる）。
    function compare(extracted, adobeParsed, opts) {
        opts = opts || {};
        var keepNewlines = (opts.keepNewlines === undefined) ? true : !!opts.keepNewlines;
        var primaryOnly = (opts.primaryOnly === undefined) ? true : !!opts.primaryOnly;
        var nrm = function (s) { return normalizeForCompare(s, { keepNewlines: keepNewlines }); };

        var adobeRows = (adobeParsed && adobeParsed.rows) ? adobeParsed.rows : [];

        // 抽出側をフラットな「テキスト1件」のリストにする
        var mine = [];
        var graphics = (extracted && extracted.graphics) ? extracted.graphics : [];
        for (var g = 0; g < graphics.length; g++) {
            for (var t = 0; t < graphics[g].texts.length; t++) {
                if (primaryOnly && graphics[g].texts[t].primary === false) { continue; }
                mine.push({
                    text: graphics[g].texts[t].text,
                    trackLabel: graphics[g].trackLabel,
                    clipName: graphics[g].clipName,
                    startSeconds: graphics[g].start ? graphics[g].start.seconds : null,
                    via: graphics[g].texts[t].via,
                    disabled: graphics[g].disabled,
                    isNestedSequence: graphics[g].isNestedSequence
                });
            }
        }

        // 多重集合
        var bucket = {};
        for (var i = 0; i < mine.length; i++) {
            var k = nrm(mine[i].text);
            if (!bucket[k]) { bucket[k] = []; }
            bucket[k].push(mine[i]);
        }

        var matched = [], missing = [];
        for (var a = 0; a < adobeRows.length; a++) {
            var ka = nrm(adobeRows[a].text);
            if (bucket[ka] && bucket[ka].length) {
                var hit = bucket[ka].shift();
                matched.push({ adobe: adobeRows[a], mine: hit });
            } else {
                missing.push(adobeRows[a]);
            }
        }
        // 使われずに残った抽出結果＝余分
        var extra = [];
        for (var key in bucket) {
            if (!Object.prototype.hasOwnProperty.call(bucket, key)) { continue; }
            for (var e = 0; e < bucket[key].length; e++) { extra.push(bucket[key][e]); }
        }

        var rate = adobeRows.length ? (matched.length / adobeRows.length) : (mine.length ? 0 : 1);
        return {
            adobeCount: adobeRows.length,
            extractCount: mine.length,
            exactMatches: matched.length,
            missingCount: missing.length,
            extraCount: extra.length,
            coverageRate: rate,                                  // 0..1（Adobeにある本文を何割取れたか）
            coveragePercent: Math.round(rate * 10000) / 100,     // 小数2桁
            matched: matched,
            missing: missing,
            extra: extra,
            compareOptions: { keepNewlines: keepNewlines, primaryOnly: primaryOnly },
            warnings: (adobeParsed && adobeParsed.warnings) ? adobeParsed.warnings.slice() : []
        };
    }

    var API = {
        extract: extract,
        parseCsv: parseCsv,
        parseAdobeCsv: parseAdobeCsv,
        compare: compare,
        normalizeForCompare: normalizeForCompare,
        rejectReason: rejectReason,
        candidatesFromParam: candidatesFromParam,
        candidatesFromComponent: candidatesFromComponent
    };
    if (typeof module !== 'undefined' && module.exports) { module.exports = API; }
    root.KMTextExtract = API;
})(typeof window !== 'undefined' ? window : this);
