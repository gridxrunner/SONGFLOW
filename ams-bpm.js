/* AI Music Suite — offline BPM detector (no dependencies, file://-safe).
   Isolates the kick/bass band with an OfflineAudioContext low/high-pass render,
   finds rhythmic peaks, and picks the most common inter-peak tempo, folded into
   a musical range. Based on the well-established Web Audio beat-detection method
   (Joe Sullivan / Tornqvist). Returns an integer BPM, or null if it can't tell. */
async function detectBpm(buffer) {
  if (!buffer || !buffer.length) return null;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return null;

  // offline render through low-pass(150) → high-pass(100): keep the kick band
  const oac = new OAC(1, buffer.length, buffer.sampleRate);
  const src = oac.createBufferSource(); src.buffer = buffer;
  const lp = oac.createBiquadFilter(); lp.type = "lowpass";  lp.frequency.value = 150;
  const hp = oac.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 100;
  src.connect(lp); lp.connect(hp); hp.connect(oac.destination); src.start(0);
  const rendered = await oac.startRendering();
  const data = rendered.getChannelData(0);
  const sr = rendered.sampleRate;

  // peak amplitude
  let max = 0;
  for (let i = 0; i < data.length; i++) { const a = data[i] < 0 ? -data[i] : data[i]; if (a > max) max = a; }
  if (max <= 0) return null;

  // collect peaks with a ~0.2s refractory; lower the threshold until we have enough
  const refractory = Math.floor(sr * 0.2);
  let peaks = [];
  for (let thr = 0.9; thr >= 0.2 && peaks.length < 30; thr -= 0.05) {
    peaks = []; const T = max * thr;
    for (let i = 0; i < data.length; i++) {
      const a = data[i] < 0 ? -data[i] : data[i];
      if (a > T) { peaks.push(i); i += refractory; }
    }
  }
  if (peaks.length < 4) return null;

  // tempo histogram: interval between each peak and its next ~10 neighbours,
  // folded into [90,180] so half/double-time votes reinforce the true pulse
  const counts = {};
  for (let i = 0; i < peaks.length; i++) {
    for (let j = 1; j <= 10 && i + j < peaks.length; j++) {
      const interval = peaks[i + j] - peaks[i];
      if (interval <= 0) continue;
      let bpm = 60 / (interval / sr);
      while (bpm < 90) bpm *= 2;
      while (bpm > 180) bpm /= 2;
      const key = Math.round(bpm);
      if (key >= 90 && key <= 180) counts[key] = (counts[key] || 0) + 1;
    }
  }
  // pick the strongest, then merge immediate neighbours (±1) for a stable center
  let best = null, bestC = 0;
  for (const k in counts) if (counts[k] > bestC) { bestC = counts[k]; best = +k; }
  if (best == null) return null;
  let num = 0, den = 0;
  for (let k = best - 2; k <= best + 2; k++) if (counts[k]) { num += k * counts[k]; den += counts[k]; }
  return Math.round(num / den);
}
