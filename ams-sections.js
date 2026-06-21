/* AI Music Suite — offline arrangement-section detector (standalone).
   Foote-style novelty on log-mel features → section boundaries, snapped to beats.
   No server: runs on a decoded AudioBuffer in the browser. Approximate — regions
   come back with confidence<0.75 so the timeline marks them "?" (rename to taste). */
(function (global) {
  // compact iterative radix-2 FFT (in-place, magnitude only needed)
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = i + k + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // returns [{start,end,label,confidence}] — labels Section A/B/C (repeats reuse letters)
  function detectSections(buf, opts) {
    opts = opts || {};
    const sr = buf.sampleRate, dur = buf.duration;
    if (dur < 12) return [];
    // mono
    let x;
    if (buf.numberOfChannels > 1) {
      const a = buf.getChannelData(0), b = buf.getChannelData(1);
      x = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) x[i] = (a[i] + b[i]) * 0.5;
    } else x = buf.getChannelData(0);

    const N = 1024, hop = Math.floor(sr * 0.25), BANDS = 16;
    const nf = Math.max(2, Math.floor((x.length - N) / hop));
    const hann = new Float32Array(N);
    for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    // log-spaced band edges (FFT bins)
    const edge = [];
    for (let b = 0; b <= BANDS; b++) {
      const f = 40 * Math.pow((sr / 2) / 40, b / BANDS);
      edge.push(Math.min(N / 2, Math.max(1, Math.floor(f / (sr / N)))));
    }
    const re = new Float32Array(N), im = new Float32Array(N);
    const feat = [];
    for (let fr = 0; fr < nf; fr++) {
      const off = fr * hop;
      for (let i = 0; i < N; i++) { re[i] = x[off + i] * hann[i]; im[i] = 0; }
      fft(re, im);
      const v = new Float32Array(BANDS);
      for (let b = 0; b < BANDS; b++) {
        let s = 0, c = 0;
        for (let k = edge[b]; k < edge[b + 1]; k++) { s += Math.hypot(re[k], im[k]); c++; }
        v[b] = Math.log(1e-6 + (c ? s / c : 0));
      }
      feat.push(v);
    }
    // z-score each band across time
    for (let b = 0; b < BANDS; b++) {
      let m = 0; for (const v of feat) m += v[b]; m /= feat.length;
      let sd = 0; for (const v of feat) sd += (v[b] - m) ** 2; sd = Math.sqrt(sd / feat.length) || 1;
      for (const v of feat) v[b] = (v[b] - m) / sd;
    }
    // novelty: cosine distance between the mean of W frames before vs after each frame
    const W = Math.max(4, Math.round(2 / 0.25));        // ~2s lookaround
    const nov = new Float32Array(nf);
    const mean = (a, b) => {
      const m = new Float32Array(BANDS), n = b - a;
      for (let i = a; i < b; i++) for (let k = 0; k < BANDS; k++) m[k] += feat[i][k];
      for (let k = 0; k < BANDS; k++) m[k] /= n; return m;
    };
    for (let i = W; i < nf - W; i++) {
      const p = mean(i - W, i), q = mean(i, i + W);
      let dot = 0, np = 0, nq = 0;
      for (let k = 0; k < BANDS; k++) { dot += p[k] * q[k]; np += p[k] * p[k]; nq += q[k] * q[k]; }
      nov[i] = 1 - dot / (Math.sqrt(np * nq) || 1);
    }
    // smooth
    const sm = new Float32Array(nf), R = 2;
    for (let i = 0; i < nf; i++) { let s = 0, c = 0; for (let j = -R; j <= R; j++) { const t = i + j; if (t >= 0 && t < nf) { s += nov[t]; c++; } } sm[i] = s / c; }
    // peak-pick with a minimum spacing that scales to duration (~1 boundary / 18s)
    const minGap = Math.max(8, Math.round(dur / Math.max(2, Math.round(dur / 18))));
    const minGapFr = Math.round(minGap / 0.25);
    let mx = 0; for (const v of sm) if (v > mx) mx = v;
    const thr = mx * 0.35;
    const bounds = [0];
    for (let i = W; i < nf - W; i++) {
      if (sm[i] > thr && sm[i] >= sm[i - 1] && sm[i] > sm[i + 1]) {
        const t = i * hop / sr;
        if (t - bounds[bounds.length - 1] >= minGap) bounds.push(t);
      }
    }
    bounds.push(dur);
    // snap boundaries to nearest beat if we have them
    const beats = opts.beats;
    const snap = t => {
      if (!beats || !beats.length) return t;
      let best = t, d = 1e9;
      for (const b of beats) { const dd = Math.abs(b - t); if (dd < d) { d = dd; best = b; } }
      return d < 1.2 ? best : t;
    };
    for (let i = 1; i < bounds.length - 1; i++) bounds[i] = snap(bounds[i]);
    // build regions; label by similarity so repeats share a letter (A/B/C…)
    const segs = [], cents = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i], b = bounds[i + 1];
      if (b - a < 4) continue;
      const fa = Math.floor(a * sr / hop), fb = Math.min(nf, Math.floor(b * sr / hop));
      const c = mean(Math.max(0, fa), Math.max(fa + 1, fb));
      let label = null;
      for (let li = 0; li < cents.length; li++) {
        let dot = 0, n1 = 0, n2 = 0;
        for (let k = 0; k < BANDS; k++) { dot += c[k] * cents[li][k]; n1 += c[k] * c[k]; n2 += cents[li][k] * cents[li][k]; }
        if (dot / (Math.sqrt(n1 * n2) || 1) > 0.6) { label = String.fromCharCode(65 + li); break; }
      }
      if (label === null) { cents.push(c); label = String.fromCharCode(65 + cents.length - 1); }
      segs.push({ start: a, end: b, label: "Section " + label, confidence: 0.5 });
    }
    return segs;
  }

  global.detectSections = detectSections;
})(window);
