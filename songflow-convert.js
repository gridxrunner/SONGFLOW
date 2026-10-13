/* Songflow lyric-file converter: turns plain lyric files (.txt / .md / .lrc) into Songflow projects.
   Section headers in the usual styles ("Verse 1:", "(Chorus)", "[Hook]", "CHORUS", "**Bridge**",
   "## Outro") become [tags]. A file with no headers is tagged by paragraph, and a paragraph that
   repeats is the Chorus. Chord-only lines and .lrc timestamps are dropped. Also builds .sflow files
   (no audio, same container the studio writes) and a plain stored zip for downloading several. */
(function (global) {
  const KEY = "intro|verse|pre[- ]?chorus|prechorus|chorus|post[- ]?chorus|hook|bridge|breakdown|break|refrain|outro|" +
    "interlude|drop|build[- ]?up|buildup|instrumental(?:\\s+break)?|rap|spoken(?:\\s+word)?|skit|coda|vamp|ad[- ]?libs?|adlibs?|part|section";
  const HDR = new RegExp("^(?:#{1,6}\\s*)?(?:\\*\\*|__)?\\s*[\\[\\(\\{]?\\s*(" + KEY + ")\\b([^\\]\\)\\}]{0,32}?)\\s*[\\]\\)\\}]?\\s*(?:\\*\\*|__)?\\s*:?\\s*$", "i");
  const NAMES = { "prechorus": "Pre-Chorus", "pre chorus": "Pre-Chorus", "pre-chorus": "Pre-Chorus", "post chorus": "Post-Chorus",
    "post-chorus": "Post-Chorus", "build up": "Build-Up", "build-up": "Build-Up", "buildup": "Build-Up", "ad lib": "Ad-libs",
    "ad libs": "Ad-libs", "ad-lib": "Ad-libs", "ad-libs": "Ad-libs", "adlib": "Ad-libs", "adlibs": "Ad-libs",
    "instrumental break": "Instrumental Break", "spoken word": "Spoken Word" };
  const LRC_TS = /^(\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+/;
  const LRC_META = /^\s*\[(ar|ti|al|au|by|offset|length|re|ve|la|id|#)\s*:[^\]]*\]\s*$/i;
  const CHORD = /^[A-G](?:#|b)?(?:maj|min|m|dim|aug|sus|add)?\d*(?:\/[A-G](?:#|b)?)?$/;

  // the tag name a header line stands for, or null when the line is lyrics. atStart: the line opens a
  // paragraph (first line, or after a blank) — a bare unbracketed header must, and must be capitalised
  function headerName(line, atStart) {
    const t = line.trim();
    if (!t || t.length > 52) return null;
    const m = t.match(HDR);
    if (!m) {                                                 // any whole-line [bracket] is already Songflow tag syntax
      const b = t.match(/^\[([^\[\]]{1,48})\]$/);
      return b ? b[1].trim() : null;
    }
    const wrapped = /^(#|\*\*|__|[\[\(\{])/.test(t) || /([\]\)\}:]|\*\*|__)\s*$/.test(t);
    const rest = (m[2] || "").replace(/^[\s:\-–—]+|[\s:\-–—]+$/g, "");
    // bare "Chorus girls dancing" is a lyric; bare "VERSE 2" / "Hook x2" is a header
    if (!wrapped && rest && !/^(\d+|[ivx]+|x\s*\d+|\d+\s*x)$/i.test(rest)) return null;
    if (!wrapped && (atStart === false || !/^[A-Z]/.test(t))) return null;   // a lowercase "hook" mid-verse is a lyric
    if (rest.split(/\s+/).length > 6) return null;
    const base = m[1].toLowerCase().replace(/\s+/g, " ");
    let name = NAMES[base] || base.replace(/\b\w/g, c => c.toUpperCase());
    if (rest) name += (/^(\d|x\s*\d)/i.test(rest) ? " " : " - ") + rest;   // "Verse 2", "Chorus x2", "Verse 1: Kendrick", "Hook - repeat"
    return name;
  }
  const isChordLine = l => { const toks = l.trim().split(/\s+/); return toks.length > 0 && toks[0] !== "" && toks.every(x => CHORD.test(x)); };

  // decode a file's bytes: UTF-8, else UTF-16 by BOM, else Windows-1252 (old Notepad files)
  function decode(buf) {
    const u = new Uint8Array(buf);
    if (u[0] === 0xFF && u[1] === 0xFE) return new TextDecoder("utf-16le").decode(u.subarray(2));
    if (u[0] === 0xFE && u[1] === 0xFF) return new TextDecoder("utf-16be").decode(u.subarray(2));
    try { return new TextDecoder("utf-8", { fatal: true }).decode(u).replace(/^\uFEFF/, ""); }
    catch (e) { return new TextDecoder("windows-1252").decode(u); }
  }

  /* raw lyric text → {text, sections:[names], bars, tagged:"headers"|"paragraphs"|"single"} */
  function convertText(raw) {
    let lines = String(raw || "").replace(/\r\n?/g, "\n").replace(/\t/g, " ").split("\n").map(l => l.replace(/\s+$/, ""));
    const nonEmpty = lines.filter(l => l.trim());
    if (nonEmpty.length && nonEmpty.filter(l => LRC_TS.test(l)).length / nonEmpty.length >= 0.3) {   // an .lrc file
      lines = lines.filter(l => !LRC_META.test(l)).map(l => l.replace(LRC_TS, "").replace(/<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, "").trim());
    }
    lines = lines.filter(l => !isChordLine(l));
    const pre = [], secs = []; let cur = null;
    let prevBlank = true;
    for (const l of lines) {
      const h = headerName(l, prevBlank);
      prevBlank = !l.trim();
      if (h) { cur = { name: h, lines: [] }; secs.push(cur); }
      else if (cur) cur.lines.push(l.trim());
      else pre.push(l.trim());
    }
    let tagged = "headers";
    if (!secs.length) {                                       // no headers → tag the paragraphs
      const paras = []; let p = [];
      for (const l of pre) { if (l) p.push(l); else if (p.length) { paras.push(p); p = []; } }
      if (p.length) paras.push(p);
      pre.length = 0;
      const key = ps => ps.join(" ").toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
      const seen = {}; paras.forEach(ps => { const k = key(ps); seen[k] = (seen[k] || 0) + 1; });
      let v = 0;
      tagged = paras.length > 1 ? "paragraphs" : "single";
      paras.forEach(ps => secs.push({ name: (paras.length > 1 && seen[key(ps)] > 1) ? "Chorus" : "Verse " + (++v), lines: ps }));
      if (v === 1 && !secs.some(s => s.name === "Chorus")) secs[0] && (secs[0].name = "Verse 1");
    }
    const tidy = ls => {                                      // no blank lines at the edges, at most one in a row inside
      const out = []; for (const l of ls) { if (!l && (!out.length || !out[out.length - 1])) continue; out.push(l); }
      while (out.length && !out[out.length - 1]) out.pop();
      return out;
    };
    const blocks = [];
    const preT = tidy(pre); if (preT.length) blocks.push(preT.join("\n"));
    for (const s of secs) { const ls = tidy(s.lines); blocks.push("[" + s.name + "]" + (ls.length ? "\n" + ls.join("\n") : "")); }
    const text = blocks.join("\n\n");
    const bars = text.split("\n").filter(l => l.trim() && !/^\[.*\]$/.test(l.trim())).length;
    return { text, sections: secs.map(s => s.name), bars, tagged };
  }

  /* a .sflow file (no audio): 8-byte magic + u32 LE JSON length + JSON — what the studio writes */
  function sflowBytes(name, text, from) {
    const meta = { format: "songflow", version: 1, name: name || "Lyrics", text: text || "", manualBars: null, layoutV: 2, savedAt: Date.now(), convertedFrom: from || null };
    const j = new TextEncoder().encode(JSON.stringify(meta)), out = new Uint8Array(12 + j.length);
    out.set(new TextEncoder().encode("SONGFLW1"), 0);
    new DataView(out.buffer).setUint32(8, j.length, true);
    out.set(j, 12);
    return out;
  }
  // a safe file name; letters in any language survive
  const fileBase = n => (String(n || "lyrics").replace(/[^\p{L}\p{N}\-]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "lyrics");

  /* a plain zip (stored, no compression): [{name, data:Uint8Array}] → Blob */
  const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    const d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true); lh.setUint32(18, sz, true);
      lh.setUint32(22, sz, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), nm, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, sz, true); ch.setUint32(24, sz, true); ch.setUint16(28, nm.length, true);
      ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), nm);
      off += 30 + nm.length + sz;
    }
    const cdSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
  }

  global.SFConvert = { convertText, decode, sflowBytes, fileBase, zip, headerName };
})(typeof window !== "undefined" ? window : globalThis);
