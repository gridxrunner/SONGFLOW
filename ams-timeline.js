/* AI Music Suite — THE timeline component (hard rule 6: one component, configured
   per tab, never forked).

   Founder round 3 semantics:
   - Ruler is BARS ONLY (BPM via setTempo; default 120). No time readouts on the ruler.
   - A clock readout shows the exact time of the last click (toolbar, right side).
   - Region strip along the TOP: drag to create a region; setRegions() injects
     arrangement-tag regions ([intro], [chorus]…). Click a region to select it.
   - Loop toggle: playback engines read getLoop() and wrap.
   - Wheel = zoom at cursor, Shift+wheel = pan. Play/pause button + SPACEBAR
     delegate to opts.onPlayPause().
   - Composite lane is an optional scratch pad (closable; never auto-filled).
     Copy/paste/duplicate/delete fire opts.onClip(op, clip) for engines that
     implement buffer surgery (Stem tab does); others toast.
*/
class AMSTimeline {
  constructor(host, opts = {}) {
    this.host = host; this.opts = opts;
    // lane-label width comes from CSS (--lanelabel) so mobile can shrink it
    this._readLbl = () => { const v = parseInt(getComputedStyle(this.host)
      .getPropertyValue("--lanelabel")); this.LBL = isNaN(v) ? 174 : v; };   // 0 is valid
    this.selRegions = [];    // selected arrangement regions (contiguous indices); loop acts on these
    this._readLbl();
    this.lanes = []; this.duration = 0; this.playhead = 0;
    this.bpm = 120; this.beatsPerBar = 4;
    this.pxPerSec = 0;
    this.snap = true;
    this.snapDiv = 4;            // play-marker snap step in BEATS (4=whole note·default, 2=½, 1=beat, .5=⅛, .25=1⁄16)
    this.sel = null; this.selectedLane = null;
    this.regions = [];           // {start,end,label,tag?}
    this.selRegion = -1;
    this.reorderable = false;    // when true, dragging a region REORDERS it (and the linked lyric block) instead of time-shifting
    this.sectionMarkers = [];    // non-destructive audio-detected section starts (dashed overlay; never replace regions)
    this.gridOffset = 0;         // ANCHOR: audio-time (s) of bar 1's downbeat. Bar b sits at gridOffset + b*secPerBar,
                                 // so changing the BPM pivots the whole grid around this point (DJ-style beatgrid anchor).
    this._anchorArm = false;     // when true, the next timeline click DROPS the anchor instead of seeking
    this.slipDrag = false;       // when true, dragging the numbered ruler SHIFTS the whole grid (slip)
    this.warpShow = false;       // "warping vision": when true, warp markers are visible AND editable (click=add/move, drag=move)
    this.warpMarkers = [];       // downbeat pins (audio-time seconds); the warped beat grid is computed in the host and pushed via setBeats
    this.loop = false;
    this.clip = null;            // clipboard {laneId,label,start,end}
    this.showComposite = sessionStorage.getItem("ams.composite." + location.pathname) !== "closed";
    window._amsTL = this;   // lets shared helpers (setLive) reach the page's timeline
    this.compositeSegs = [];     // [{label,start,dur}] visual segments (engine owns audio)
    host.classList.add("tlhost");
    host.innerHTML = `
      <div class="tlbar">
        <button class="tool playtl" data-op="playpause" title="play/pause (space)">&#9654;</button>
        <span class="sep"></span>
        <button class="tool" data-op="zoomout" title="zoom out (wheel)">&#8722;</button>
        <button class="tool" data-op="zoomin" title="zoom in (wheel)">&#43;</button>
        <button class="tool" data-op="fit">Fit</button>
        <span class="sep"></span>
        <button class="tool on" data-op="snap" title="toggle snapping on/off">Snap</button>
        <select class="tool tsnap" data-op="snapdiv" title="play-marker snap resolution">
          <option value="4" selected>whole note</option>
          <option value="2">&frac12; note</option>
          <option value="1">&frac14; &middot; beat</option>
          <option value="0.5">&frac18; note</option>
          <option value="0.25">1/16 note</option>
        </select>
        <button class="tool" data-op="loop" title="loop the selected arrangement region(s) — they turn red while looping">&#128257; Loop selected</button>
        <button class="tool" data-op="delsection" title="delete the selected region(s) and their lyrics">&#128465; Delete region</button>
        <button class="tool" data-op="alllanes" title="selection applies to every lane">All lanes</button>
        <button class="tool" data-op="selectall">All</button>
        <span class="sep"></span>
        <button class="tool" data-op="copy">Copy</button>
        <button class="tool" data-op="paste" title="paste into composite">Paste</button>
        <button class="tool" data-op="duplicate">Dup</button>
        <button class="tool" data-op="delete">Del</button>
        <span class="sep"></span>
        <button class="tool" data-op="heal">Heal</button>
        <button class="tool" data-op="slip">Slip</button>
        <button class="tool" data-op="midi">MIDI</button>
        <span class="tlclock" title="exact time at last click">&#128337; 0:00.000</span>
        <span class="tlselinfo muted"></span>
      </div>
      <div class="lanesArea"><div class="tlscroll"></div></div>`;
    this.bar = host.querySelector(".tlbar");
    this.area = host.querySelector(".lanesArea");
    this.scrollEl = host.querySelector(".tlscroll");
    this.selInfo = host.querySelector(".tlselinfo");
    this.clockEl = host.querySelector(".tlclock");
    this.playBtn = host.querySelector(".playtl");
    this.bar.querySelectorAll("button[data-op]").forEach(b => b.onclick = () => this._op(b.dataset.op, b));
    const snapSel = this.bar.querySelector('[data-op="snapdiv"]');
    if (snapSel) snapSel.onchange = e => { this.snapDiv = +e.target.value || 1; };
    // While the anchor is armed, a click ANYWHERE on the timeline (ruler, tag strip, OR the
    // waveform) drops the grid anchor — not only on the waveform lane. Capture phase so it
    // wins before region-select / seek handlers.
    this.area.addEventListener("mousedown", e => {
      if (this._anchorArm) { e.preventDefault(); e.stopPropagation(); this.setAnchorAt(e.clientX); return; }
      // WARP-EDIT mode ("warping vision" on): click empty space to DROP a downbeat pin, click an
      // existing pin to grab it (drag = move, release-in-place = remove). Markers bend the grid.
      if (this.warpShow && !this.slipDrag) {
        e.preventDefault(); e.stopPropagation();
        const t = this._tAtClientX(e.clientX), pxPer = this._width() / (this.duration || 1);
        let hit = -1; this.warpMarkers.forEach((m, idx) => { if (Math.abs((m - t) * pxPer) < 7) hit = idx; });
        if (hit >= 0) this._warpDrag = { idx: hit, x0: e.clientX, moved: false };
        else { this.opts.onWarpStart && this.opts.onWarpStart(); this.opts.onWarpAdd && this.opts.onWarpAdd(this._snapToTransient(t)); }
        return;
      }
      // SLIP-DRAG mode: a drag ANYWHERE on the timeline shoves the whole grid (not just the ruler)
      if (this.slipDrag) { e.preventDefault(); e.stopPropagation(); this.opts.onSlipStart && this.opts.onSlipStart(); this._slip = { x0: e.clientX, off0: this.gridOffset }; }
    }, true);

    this.area.addEventListener("wheel", e => {
      if (e.shiftKey) { this.area.scrollLeft += (e.deltaY || e.deltaX); e.preventDefault(); return; }
      e.preventDefault();
      const fitPps = (this.area.clientWidth - this.LBL) / (this.duration || 1);
      const cur = this.pxPerSec || fitPps;
      const next = Math.min(this._maxPxPerSec(), e.deltaY < 0 ? cur / 1.18 : cur * 1.18);   // scroll down = zoom in (founder)
      const anchorT = this._tAtClientX(e.clientX);
      this.pxPerSec = next * this.duration <= this.area.clientWidth - this.LBL ? 0 : next;
      this.render();
      // keep the time under the cursor stationary
      if (this.pxPerSec) {
        const want = this._x(anchorT) - (e.clientX - this.area.getBoundingClientRect().left);
        this.area.scrollLeft = Math.max(0, want);
      }
    }, { passive: false });

    window.addEventListener("resize", () => { this._readLbl(); this.render(); });
    // region drag-move (ripple) + drag-to-create live at window level so the drag
    // keeps tracking even if the pointer leaves the strip
    window.addEventListener("mousemove", e => this._onStripMove(e));
    window.addEventListener("mouseup", e => this._onStripUp(e));
    document.addEventListener("keydown", e => {
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) ||
          document.activeElement.isContentEditable) return;
      if (e.code === "Space") { e.preventDefault(); this.opts.onPlayPause && this.opts.onPlayPause(true); }    // play / STOP-and-return
      if (e.key === "Enter") { e.preventDefault(); this.opts.onPlayPause && this.opts.onPlayPause(false); }    // play / pause-in-place
      if (e.key === "Escape") { this.sel = null; this.selRegion = -1; this.selRegions = []; this.loop = false; this.render(); }
      if ((e.key === "Delete" || e.key === "Backspace") && this.reorderable && this.selRegions.length) {
        e.preventDefault(); this._op("delsection");
      }
      if (e.key === "a" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this._op("selectall"); }
    });
  }

  /* ---- public API ---- */
  setLanes(lanes) { this.lanes = lanes; this.render(); }
  setDuration(d) { this.duration = Math.max(d || 0, 0); this.render(); }
  setTempo(bpm, beatsPerBar = 4) { if (bpm) { this.bpm = bpm; this.beatsPerBar = beatsPerBar; this.render(); } }
  setBeats(beats) {   // real beat times from analysis: snap + bars follow the groove
    this.beats = (beats && beats.length > 8) ? beats : null;
    this.render();
  }
  /* warp pins: the host owns the marker list + the warped beat math; this just stores them
     for drawing and toggles "warping vision" (visible+editable). show=false → hidden but the
     warped grid (pushed via setBeats) stays in effect. */
  setWarp(markers, show) { this.warpMarkers = (markers || []).slice(); if (show !== undefined) this.warpShow = !!show; this.render(); }
  armWarp(on = true) { this.warpShow = on !== false; this.host.classList.toggle("warping", this.warpShow); this.render(); }
  setRegions(regs) { this.regions = regs || []; this.render(); }
  setSectionMarkers(m) { this.sectionMarkers = m || []; this.render(); }
  setGridOffset(s) { this.gridOffset = s || 0; this.render(); }
  /* ---- beatgrid anchor (DJ-style): click a downbeat to make it bar 1 ---- */
  armAnchor(on = true) { this._anchorArm = on !== false; this.host.classList.toggle("anchoring", this._anchorArm); }
  // snap a clicked time to the loudest sample within ±20ms (the downbeat's attack), if a real transient is there
  _snapToTransient(t) {
    const lane = this.lanes.find(l => l.buffer); if (!lane) return t;
    const d = lane.buffer.getChannelData(0), sr = lane.buffer.sampleRate;
    const c = Math.round(t * sr), win = Math.round(0.02 * sr);
    let bi = c, best = -1;
    for (let i = Math.max(0, c - win); i < Math.min(d.length, c + win); i++) {
      const v = Math.abs(d[i]); if (v > best) { best = v; bi = i; }
    }
    return best > 0.02 ? bi / sr : t;     // only snap when there's an actual transient nearby
  }
  setAnchorAt(clientX) {
    const t = this._snapToTransient(this._tAtClientX(clientX));
    this.gridOffset = t; this._anchorArm = false; this.host.classList.remove("anchoring");
    this.render(); this.opts.onAnchor && this.opts.onAnchor(t);
  }
  setComposite(segs) { this.compositeSegs = segs || []; this.render(); }
  setPlaying(on) { this.playBtn.innerHTML = on ? "&#10074;&#10074;" : "&#9654;"; }
  setPlayhead(t) {
    this.playhead = t;
    const px = this._x(t);
    this.host.querySelectorAll(".playhead").forEach(p => p.style.left = px + "px");
  }
  getLoop() {
    if (!this.loop) return null;                         // loop must be activated (button)
    if (this.selRegions && this.selRegions.length) {
      // loop only a CONTIGUOUS run anchored at the last-clicked region — a single
      // start→end span can't have holes, so never let an unselected gap region in
      const set = new Set(this.selRegions);
      let anchor = set.has(this.selRegion) ? this.selRegion : Math.min(...this.selRegions);
      let lo = anchor, hi = anchor;
      while (set.has(lo - 1)) lo--;
      while (set.has(hi + 1)) hi++;
      const rs = [];
      for (let k = lo; k <= hi; k++) if (this.regions[k]) rs.push(this.regions[k]);
      if (rs.length) return { start: Math.min(...rs.map(r => r.start)), end: Math.max(...rs.map(r => r.end)) };
    }
    return this.sel;                                     // fallback: a custom dragged region
  }

  /* index of the region whose span sits under the pointer (clamped to ends) */
  _regionIndexAtClientX(clientX) {
    const t = this._tAtClientX(clientX) - this.gridOffset;   // pointer audio-time → bar-space
    for (let i = 0; i < this.regions.length; i++)
      if (t >= this.regions[i].start && t < this.regions[i].end) return i;
    if (!this.regions.length) return -1;
    if (t >= this.regions[this.regions.length - 1].end) return this.regions.length - 1;
    if (t < this.regions[0].start) return 0;
    return -1;
  }

  /* ---- arrangement drag (reorderable tabs) ----
     Two modes, decided by the selection at mouse-down:
     • ALIGN (single region selected): the section floats with the cursor and, on
       release, snaps into the gap under the drop point if it has room — else snaps
       back. It can jump over other sections to reach an open slot.
     • BLOCK (2+ regions selected via Ctrl+Click): the selection moves as a rigid
       block; any unselected section between the ends is auto-added; sections the
       block lands on are shoved to the nearest side. The block takes priority.
     In both modes the lyric document is re-ordered to match the new left→right order. */
  _onStripMove(e) {
    if (this._warpDrag) {                                     // dragging a warp pin → live-preview its new spot
      if (!this._warpDrag.moved && Math.abs(e.clientX - this._warpDrag.x0) < 4) return;
      if (!this._warpDrag.moved) { this._warpDrag.moved = true; this.opts.onWarpStart && this.opts.onWarpStart(); }
      this.warpMarkers[this._warpDrag.idx] = this._tAtClientX(e.clientX);
      this.opts.onWarpMove && this.opts.onWarpMove(this._warpDrag.idx, this.warpMarkers[this._warpDrag.idx]);
      this.render();
      return;
    }
    if (this._slip) {                                        // slip-drag the numbered ruler → shift the grid
      const dxpx = e.clientX - this._slip.x0;
      const dt = dxpx / (this._width() / (this.duration || 1));   // px → seconds
      this.gridOffset = this._slip.off0 + dt;
      this.render();
      return;
    }
    if (this._adrag) {
      const dxpx = e.clientX - this._adrag.x0;
      if (!this._adrag.moved && Math.abs(dxpx) < 4) return;
      this._adrag.moved = true;
      const orig = this._adrag.orig, anchor = orig[this._adrag.i];
      const pxPerSec = this._width() / (this.duration || 1);
      const dt = this._snapT(anchor.start + dxpx / pxPerSec) - anchor.start;   // beat-snapped delta
      this._adrag.dt = dt;
      const set = this._adrag.set;
      this.regions = orig.map((r, k) => set.has(k) ? { ...r, start: r.start + dt, end: r.end + dt } : { ...r });
      this._layoutRegions();
      const strip = this.scrollEl.querySelector(".regionstrip");
      if (strip) strip.querySelectorAll(".region").forEach(el => el.classList.toggle("dragging", set.has(+el.dataset.ri)));
      // single-region drag = MOVE to where you drop it (left edge, beat-snapped); the insert
      // line shows the landing spot. Regions it overlaps get rippled aside on release.
      if (this._adrag.mode === 1) {
        const newStart = Math.max(0, anchor.start + dt);
        this._adrag.dropStart = newStart;
        this._showDropIndicator(this._xo(newStart));
      }
      return;
    }
    if (this._rdrag) {
      const { di, orig } = this._rdrag;
      const dxpx = e.clientX - this._rdrag.x0;
      if (!this._rdrag.moved && Math.abs(dxpx) < 4) return;     // click threshold
      this._rdrag.moved = true;
      const pxPerSec = this._width() / (this.duration || 1);
      // snap the dragged region's NEW start to the grid, derive the actual delta
      let dt = this._snapT(orig[di].start + dxpx / pxPerSec) - orig[di].start;
      // clamp: can't pass the previous region's start; can't push the last end past the track
      const prevStart = di > 0 ? orig[di - 1].start : 0;
      const minDt = (prevStart + 0.05) - orig[di].start;
      const maxDt = this.duration - orig[orig.length - 1].end;
      dt = Math.max(minDt, Math.min(maxDt, dt));
      // ripple: dragged region + everything after it shift by dt; the region before
      // it stretches to stay contiguous (its end follows the new start)
      const regs = orig.map(r => ({ ...r }));
      for (let k = di; k < regs.length; k++) { regs[k].start += dt; regs[k].end += dt; regs[k].userEdited = true; }
      if (di > 0) { regs[di - 1].end += dt; regs[di - 1].userEdited = true; }
      if (di === 0) regs[0].start = Math.max(0, regs[0].start);
      this.regions = regs;
      this.opts.onRegions && this.opts.onRegions(this.regions);   // keep page state live
      this.render();
    }
  }
  // ALIGN: place the dragged section in the gap under the drop, or null to snap back.
  // Works in seconds so the section lands on the nearest BEAT, not just whole bars.
  _arrangeAlign(a) {
    const spb = this._secPerBar(), i = a.i, orig = a.orig, eps = 1e-4;
    const L = orig[i].end - orig[i].start;                              // length (seconds)
    const total = this.duration;
    const others = orig.map((r, k) => ({ k, s: r.start, e: r.end }))
      .filter(o => o.k !== i).sort((x, y) => x.s - y.s);
    const gaps = [];                                                    // every gap between the OTHER sections
    let cur = 0;
    for (const o of others) { if (o.s > cur + eps) gaps.push({ lo: cur, hi: o.s }); cur = Math.max(cur, o.e); }
    if (total > cur + eps) gaps.push({ lo: cur, hi: total });
    const desired = this._snapT(orig[i].start + a.dt);                  // beat-snapped drop start
    const g = gaps.find(x => desired >= x.lo - eps && desired <= x.hi + eps);
    if (!g || (g.hi - g.lo) < L - eps) return null;                     // no room here → snap back
    const place = Math.max(g.lo, Math.min(g.hi - L, desired));
    const items = others.map(o => ({ i: o.k, startBar: o.s / spb }));
    items.push({ i, startBar: place / spb });
    items.sort((x, y) => x.startBar - y.startBar);
    return items;
  }
  /* REORDER (single-region drag): the arrangement is an ordered list. The drop point is an
     INSERTION INDEX between the other sections (by cursor vs each section's centre). On drop
     we rebuild the order with the dragged section spliced in and re-pack everything
     contiguously from the run's start — so dropping between two touching clips inserts there
     and pushes the rest right (no gap needed, never snaps back). */
  _insertIndexAt(clientX, draggedIdx) {
    const t = this._tAtClientX(clientX) - this.gridOffset;          // pointer → bar-space
    const others = this.regions.map((r, k) => ({ k, mid: (r.start + r.end) / 2 }))
      .filter(o => o.k !== draggedIdx).sort((x, y) => x.mid - y.mid);
    let idx = 0; for (const o of others) { if (t > o.mid) idx++; else break; }
    return idx;
  }
  _orderedOthers(orig, draggedIdx) {
    return orig.map((r, k) => ({ k, start: r.start, len: r.end - r.start }))
      .filter(o => o.k !== draggedIdx).sort((x, y) => x.start - y.start);
  }
  _dropIndicatorX(a, insertIdx) {
    const others = this._orderedOthers(a.orig, a.i);
    const base = Math.min(...a.orig.map(r => r.start));
    let cum = base; for (let j = 0; j < insertIdx && j < others.length; j++) cum += others[j].len;
    return this._xo(cum);
  }
  /* MOVE the dragged section to where it was dropped (left edge = dropStart, beat-snapped),
     leaving the others where they sit. Then ripple right to remove only ACTUAL overlaps — so a
     drop into open space just relocates it (the first section can slide left), while a drop onto
     other sections inserts there and pushes the overlapped ones aside. Order follows position. */
  _arrangeReorder(a) {
    const spb = this._secPerBar(), orig = a.orig, di = a.i, eps = 1e-6;
    const dropStart = (a.dropStart != null) ? a.dropStart : Math.max(0, orig[di].start + (a.dt || 0));
    const list = orig.map((r, k) => ({ i: k, start: k === di ? dropStart : r.start, len: r.end - r.start }));
    list.sort((x, y) => Math.abs(x.start - y.start) > eps ? x.start - y.start : (x.i === di ? -1 : y.i === di ? 1 : 0));
    let cur = 0;
    for (const o of list) { if (o.start < cur - eps) o.start = cur; cur = o.start + o.len; }
    return list.map(o => ({ i: o.i, startBar: o.start / spb }));   // already left→right
  }
  _showDropIndicator(x) {
    const strip = this.scrollEl.querySelector(".regionstrip"); if (!strip) return;
    let el = strip.querySelector(".dropind");
    if (!el) { el = document.createElement("div"); el.className = "dropind"; el.innerHTML = '<span class="dropins">&#9660;</span>'; strip.appendChild(el); }
    el.style.left = (x - this.LBL) + "px";
  }
  _clearDropIndicator() { const el = this.scrollEl.querySelector(".dropind"); if (el) el.remove(); }
  // BLOCK: move the rigid selection (beat-snapped); shove overlapped sections aside
  _arrangeBlock(a) {
    const spb = this._secPerBar(), orig = a.orig;
    const idxs = [...a.set].sort((x, y) => x - y);
    const lo = idxs[0], hi = idxs[idxs.length - 1];
    const b0 = orig[lo].start, b1 = orig[hi].end, total = this.duration, blockLen = b1 - b0;
    const nb0 = this._clamp(this._snapT(b0 + a.dt), 0, total - blockLen);
    const dt = nb0 - b0, nbEnd = nb0 + blockLen;
    const pos = orig.map((r, k) => ({ i: k, s: r.start, len: r.end - r.start, block: a.set.has(k) }));
    pos.forEach(p => { if (p.block) p.s += dt; });
    let edge = nb0;                                                     // pack left-side sections that now overlap
    pos.filter(p => !p.block && p.i < lo).sort((x, y) => y.s - x.s)
      .forEach(p => { if (p.s + p.len > edge) p.s = edge - p.len; edge = Math.min(edge, p.s); });
    edge = nbEnd;                                                       // pack right-side sections that now overlap
    pos.filter(p => !p.block && p.i > hi).sort((x, y) => x.s - y.s)
      .forEach(p => { if (p.s < edge) p.s = edge; edge = Math.max(edge, p.s + p.len); });
    return pos.map(p => ({ i: p.i, startBar: Math.max(0, p.s) / spb })).sort((x, y) => x.startBar - y.startBar);
  }
  _clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  _onStripUp(e) {
    if (this._warpDrag) {                                     // release a warp pin: moved → commit; in place → remove
      const wd = this._warpDrag; this._warpDrag = null;
      if (wd.moved) this.opts.onWarpMove && this.opts.onWarpMove(wd.idx, this.warpMarkers[wd.idx], true);
      else this.opts.onWarpRemove && this.opts.onWarpRemove(wd.idx);
      this.render(); return;
    }
    if (this._slip) {                                        // finish slip-drag → persist the new grid offset
      const off = this.gridOffset; this._slip = null;
      this.opts.onSlipDrag && this.opts.onSlipDrag(off);     // updates the Slip readout (relative to anchor) + saves
      this.render(); return;
    }
    if (this._adrag) {
      const a = this._adrag; this._adrag = null; this._clearDropIndicator();
      if (!a.moved) {                                            // no drag → select the single section
        this.selRegions = [a.i]; this.selRegion = a.i; this.sel = { ...this.regions[a.i] };
        this.opts.onSelectRegions && this.opts.onSelectRegions([this.regions[a.i]]);
        this.render(); return;
      }
      // single-region drag MOVES to the drop point (ripples overlaps); block drag shoves
      const items = a.mode === 2 ? this._arrangeBlock(a) : this._arrangeReorder(a);
      this.regions = a.orig;                                     // restore truth; page rebuilds (or this stays = snap back)
      if (items && this.opts.onArrange) {
        this.opts.onArrange(items);                              // page rewrites the doc + rebuilds regions
        // KEEP the moved section(s) selected — they're now at new indices in the rebuilt order
        const moved = a.mode === 2 ? a.set : new Set([a.i]);
        const newSel = [];
        items.forEach((it, k) => { if (moved.has(it.i)) newSel.push(k); });
        this.selRegions = newSel;
        this.selRegion = newSel.length ? newSel[newSel.length - 1] : -1;
        this.sel = (this.selRegion >= 0 && this.regions[this.selRegion]) ? { ...this.regions[this.selRegion] } : null;
        this.opts.onSelectRegions && this.opts.onSelectRegions(newSel.map(k => this.regions[k]).filter(Boolean));
        this.render();
      } else this.render();                                      // snap back
      return;
    }
    if (this._rdrag) {
      const d = this._rdrag; this._rdrag = null;
      if (!d.moved) {                                            // no drag → treat as click-select
        const i = d.di;
        this.selRegions = [i]; this.selRegion = i; this.sel = { ...this.regions[i] };
        this.opts.onSelectRegions && this.opts.onSelectRegions([this.regions[i]]);
        this.render(); return;
      }
      this.render(); return;                                     // ripple already mutated regions during move
    }
    if (this._rcreate != null) {
      const end = this._snapT(this._tAtClientX(e.clientX));
      if (Math.abs(end - this._rcreate) > 0.2) {
        this.regions.push({ start: Math.min(this._rcreate, end), end: Math.max(this._rcreate, end),
                            label: `region ${this.regions.length + 1}`, userEdited: true });
        this.selRegion = this.regions.length - 1; this.sel = { ...this.regions[this.selRegion] };
        this.opts.onRegions && this.opts.onRegions(this.regions);
      }
      this._rcreate = null; this.render();
    }
  }

  /* beat grid synced to tempo: a strong line per bar, faint lines per beat (when
     zoomed in enough). Uses real analysed beats when present, else bpm × bars. */
  _gridLines(w, spb, bars, barPx) {
    if (!this.duration) return "";
    const out = [];
    const at = (t, cls) => out.push(`<div class="bl ${cls}" style="left:${(t / this.duration) * w}px"></div>`);
    if (this.beats) {
      this.beats.forEach((t, i) => { if (i % this.beatsPerBar === 0) at(t, "bar"); else if (barPx >= 44) at(t, "beat"); });
    } else {
      const go = this.gridOffset;                                         // ANCHOR: bar 1 downbeat (BPM pivots here)
      const b0 = Math.min(0, Math.floor((0 - go) / spb));                 // extend back to t=0 when the anchor sits mid-track
      for (let b = b0; b <= bars; b++) {
        const tb = go + b * spb;
        if (tb < -spb || tb > this.duration + spb) continue;
        at(tb, "bar");
        if (barPx >= 44) for (let k = 1; k < this.beatsPerBar; k++) at(go + (b + k / this.beatsPerBar) * spb, "beat");
      }
    }
    return out.join("");
  }
  /* update region element positions in place (keeps CSS transitions smooth during drag) */
  _layoutRegions() {
    const strip = this.scrollEl.querySelector(".regionstrip"); if (!strip) return;
    strip.querySelectorAll(".region").forEach(el => {
      const r = this.regions[+el.dataset.ri]; if (!r) return;
      el.style.left = (this._xo(r.start) - this.LBL) + "px";
      el.style.width = Math.max(8, this._xo(r.end) - this._xo(r.start)) + "px";
    });
  }

  /* ---- geometry ---- */
  _secPerBar() { return (60 / this.bpm) * this.beatsPerBar; }
  _width() {
    const avail = this.area.clientWidth - this.LBL;
    if (!this.duration) return avail;
    // Cap the content width under the browser's canvas limit (Firefox: 32767px). Past
    // that the waveform canvas gets clamped while the grid keeps its full width, so they
    // drift apart — and the drift changes with zoom. Capping keeps wave + grid locked.
    return Math.round(Math.min(32000, this.pxPerSec ? Math.max(avail, this.pxPerSec * this.duration) : avail));
  }
  _maxPxPerSec() { return this.duration ? 32000 / this.duration : 1e6; }   // zoom ceiling that keeps width ≤ cap
  _x(t) { return this.duration ? this.LBL + (t / this.duration) * this._width() : this.LBL; }
  // bar-space time → pixel, shifted by the slip offset. NOTE: this is LINEAR (constant-BPM). When
  // warp is active (this.beats set) the beat grid + metronome bend, but regions are still placed
  // linearly here, so a tag edge can sit slightly off a bent bar line. Intentional for now — a full
  // warp remap of region coords is a follow-up (would need the warp's global-beat origin in here).
  _xo(t) { return this._x(t + this.gridOffset); }
  _tAtClientX(clientX) {
    const r = this.scrollEl.getBoundingClientRect();
    const x = clientX - r.left - this.LBL;
    return Math.min(this.duration, Math.max(0, (x / this._width()) * this.duration));
  }
  _snapT(t) {
    if (!this.snap) return t;
    if (this.beats) {   // snap to the nearest REAL beat
      let best = this.beats[0], d = Infinity;
      for (const b of this.beats) { const dd = Math.abs(b - t); if (dd < d) { d = dd; best = b; } }
      return best;
    }
    const beat = 60 / this.bpm;
    return Math.round(t / beat) * beat;
  }
  /* snap an AUDIO-TIME value to the play-marker grid: aligned to the anchor (gridOffset) and
     to the chosen subdivision. Bar-space snapping uses _snapT; audio-time uses this so the
     selection / playhead land exactly on the rendered grid lines. */
  _snapGrid(t) {
    if (!this.snap) return t;
    if (this.beats) {
      let best = this.beats[0], d = Infinity;
      for (const b of this.beats) { const dd = Math.abs(b - t); if (dd < d) { d = dd; best = b; } }
      return best;
    }
    const step = (60 / this.bpm) * (this.snapDiv || 1);
    return this.gridOffset + Math.round((t - this.gridOffset) / step) * step;
  }

  /* ---- toolbar ---- */
  _op(op, btn) {
    if (op === "playpause") { this.opts.onPlayPause && this.opts.onPlayPause(); return; }
    if (op === "zoomin" || op === "zoomout") {
      const fitPps = (this.area.clientWidth - this.LBL) / (this.duration || 1);
      const cur = this.pxPerSec || fitPps;
      const next = Math.min(this._maxPxPerSec(), op === "zoomin" ? cur * 1.5 : cur / 1.5);
      this.pxPerSec = next * this.duration <= this.area.clientWidth - this.LBL ? 0 : next;
      this.render(); return;
    }
    if (op === "fit") { this.pxPerSec = 0; this.render(); return; }
    if (op === "snap") { this.snap = !this.snap; btn.classList.toggle("on", this.snap); return; }
    if (op === "alllanes") { this.allLanes = !this.allLanes; btn.classList.toggle("on", this.allLanes); this._paintSel(); return; }
    if (op === "loop") {
      if (!this.loop && !this.selRegions.length && !this.sel) {
        toast("Click a section to select it first, then Loop selected."); return;
      }
      this.loop = !this.loop; btn.classList.toggle("on", this.loop);
      if (this.loop && this.reorderable && this.selRegions.length > 1) {   // looping needs contiguity → fill gaps
        this._fillSelectionGaps();
        this.opts.onSelectRegions && this.opts.onSelectRegions(this.selRegions.map(k => this.regions[k]).filter(Boolean));
      }
      const lp = this.getLoop();
      if (this.loop && lp && this.opts.onSeek) this.opts.onSeek(lp.start + this.gridOffset);   // jump into the loop (audio time)
      this.render(); return;
    }
    if (op === "delsection") {
      if (!this.reorderable) { toast("Delete works on composite segments here."); return; }
      if (!this.selRegions.length) { toast("Select a section first (click it), then Delete."); return; }
      this.opts.onDeleteRegions && this.opts.onDeleteRegions([...this.selRegions].sort((a, b) => a - b));
      return;
    }
    if (op === "selectall") { this.sel = { start: 0, end: this.duration }; this.render(); return; }
    if (op === "copy") {
      if (!this.sel || !this.selectedLane) { toast("Drag a selection on a lane first."); return; }
      this.clip = { lane: this.selectedLane, label: this.selectedLane.label, ...this.sel };
      toast(`Copied ${this.selectedLane.label} ${fmt(this.sel.start)}–${fmt(this.sel.end)} — paste lands in the composite.`);
      return;
    }
    if (op === "paste" || op === "duplicate") {
      const clip = op === "duplicate"
        ? (this.sel && this.selectedLane ? { lane: this.selectedLane, label: this.selectedLane.label, ...this.sel } : this.clip)
        : this.clip;
      if (!clip) { toast("Nothing copied yet."); return; }
      if (this.opts.onClip) this.opts.onClip("paste", clip);
      else toast("This tab's composite is visual-only for now.");
      return;
    }
    if (op === "delete") {
      if (this.opts.onClip && this.selectedLane && this.selectedLane.composite)
        this.opts.onClip("delete", this.sel);
      else toast("Delete works on composite segments (select the composite lane).");
      return;
    }
    if (op === "heal" || op === "slip") { toast(`${op === "heal" ? "Heal timing" : "Slip"} needs the bar-grid engine (allin1 downbeats) — planned.`); return; }
    if (op === "midi") { toast("Export MIDI needs the Basic Pitch worker — planned."); return; }
  }

  /* ---- render ---- */
  render() {
    const w = this._width();
    const spb = this._secPerBar();
    const bars = Math.max(1, Math.ceil(this.duration / spb));
    const barPx = w / (this.duration / spb || 1);
    const every = barPx > 36 ? 1 : barPx > 18 ? 2 : barPx > 9 ? 4 : 8;

    const all = [...this.lanes];
    if (this.showComposite)
      all.push({ id: "__composite", label: "Composite", color: "#19d3c5", composite: true,
                 armed: !!this.compositeArmed });

    this.scrollEl.style.width = (this.LBL + w) + "px";
    this.scrollEl.innerHTML = `
      <div class="rulerRow">
        <div class="rcorner"><span class="muted" style="padding-left:6px">bars</span></div>
        <div class="regionstrip" style="width:${w}px">
          ${this.regions.map((r, i) => {
            const guess = (r.confidence !== undefined && r.confidence < 0.75 && !r.userEdited);
            const txt = r.label + (guess ? " ?" : "");
            const selected = this.selRegions.includes(i);
            const looping = selected && this.loop;           // selected + loop active => red
            const hint = this.reorderable
              ? "drag to slide this section into an open spot; Ctrl+Click several then drag to move them as a block; Delete removes it (and its lyrics)"
              : "drag to move (ripples downstream)";
            // bar length is set from the word processor (click the [Tag]); the timeline just
            // shows the section's span — no dropdown here.
            const barsN = (r.bars != null) ? r.bars : (r.lenBars != null ? r.lenBars : null);
            const tip = barsN != null ? ` (${barsN} bars)` : "";
            // colour by content: lyric-bearing region vs an arrangement-only (no-lyrics) region
            const kind = (r.hasLyrics === false) ? "nolyr" : "haslyr";
            const kindTip = (r.hasLyrics === false) ? " · no lyrics (arrangement-only)" : "";
            return `<div class="region ${kind} ${selected ? "on" : ""} ${looping ? "looping" : ""}" data-ri="${i}"
              style="left:${this._xo(r.start) - this.LBL}px;width:${Math.max(8, this._xo(r.end) - this._xo(r.start))}px"
              title="${txt}${tip}${kindTip} — ${hint}, click to select, Shift+Click adjacent to extend, double-click to rename"><span class="rlbl">${txt}</span></div>`;
          }).join("")}
        </div>
      </div>
      <div class="rulerRow">
        <div class="rcorner"></div>
        <div class="ruler" style="width:${w}px">
          ${(() => { const lp = this.loop && this.getLoop(); return lp
            ? `<div class="loopfill" style="left:${this._xo(lp.start) - this.LBL}px;width:${Math.max(2, this._xo(lp.end) - this._xo(lp.start))}px"></div>` : ""; })()}
          ${this.beats
            ? Array.from({ length: Math.ceil(this.beats.length / this.beatsPerBar / every) }, (_, k) => {
                const t = this.beats[k * every * this.beatsPerBar];
                return t === undefined ? "" :
                  `<div class="tick" style="left:${(t / this.duration) * w}px">${k * every + 1}</div>`;
              }).join("")
            : (() => {                                     // numbered bars, INCLUDING negative bars left of the anchor
                const start = Math.floor(Math.floor((0 - this.gridOffset) / spb) / every) * every;
                const out = [];
                for (let bar = start; bar <= bars; bar += every) {
                  const x = this._xo(bar * spb) - this.LBL;
                  if (x < -24 || x > w + 24) continue;
                  out.push(`<div class="tick${bar < 0 ? " negt" : ""}" style="left:${x}px">${bar + 1}</div>`);
                }
                return out.join("");
              })()}
        </div>
      </div>
      ${all.map(l => this._laneHtml(l, w)).join("")}
      <div class="beatgrid" style="left:${this.LBL}px;width:${w}px">${this._gridLines(w, spb, bars, barPx)}</div>
      ${this.sectionMarkers && this.sectionMarkers.length ? `<div class="sectmarks" style="left:${this.LBL}px;width:${w}px">`+
        this.sectionMarkers.filter(t => this.duration && t < this.duration).map(t => `<div class="sectmark" style="left:${(t / this.duration) * w}px"></div>`).join("")+`</div>` : ""}
      ${(() => { const lp = this.loop && this.getLoop(); return lp
        ? `<div class="loopband" style="left:${this._xo(lp.start)}px;width:${Math.max(2, this._xo(lp.end) - this._xo(lp.start))}px"></div>` : ""; })()}
      ${this.duration ? `<div class="gridanchor" style="left:${this._x(this.gridOffset)}px" title="grid anchor — bar 1 downbeat"></div>` : ""}
      ${this.warpShow && this.duration && this.warpMarkers.length
        ? `<div class="warplane" style="left:${this.LBL}px;width:${w}px">` +
          this.warpMarkers.filter(t => t >= -0.5 && t < this.duration + 0.5)
            .map(t => `<div class="warpmark" style="left:${(t / this.duration) * w}px" title="warp pin — drag to move, click to remove"><span class="wmh">&#9670;</span></div>`).join("") +
          `</div>` : ""}
      <div class="playhead" style="left:${this._x(this.playhead)}px"></div>`;

    // SLIP-DRAG: when on, the whole timeline gets the ↔ cursor and a drag shoves the grid
    // (the capture-phase mousedown above handles the actual drag start).
    if (this.area) this.area.style.cursor = this.slipDrag ? "ew-resize" : (this.warpShow ? "crosshair" : "");

    // region strip interactions. Reorderable tabs (lyric suite): Ctrl+Click builds a
    // multi-selection; dragging one section = ALIGN, dragging a multi-selection = BLOCK.
    // Other tabs keep the ripple-move / drag-to-create behaviour.
    const strip = this.scrollEl.querySelector(".regionstrip");
    strip.onmousedown = e => {
      const regEl = e.target.closest(".region");
      if (regEl && e.altKey && this.reorderable) {            // Alt+Click → open the tag-options menu (bars / rename / delete)
        e.preventDefault(); e.stopPropagation();
        this.opts.onRegionMenu && this.opts.onRegionMenu(+regEl.dataset.ri, e.clientX, e.clientY);
        return;
      }
      if (regEl) {
        const i = +regEl.dataset.ri;
        if (this.reorderable && (e.ctrlKey || e.metaKey)) {   // Ctrl/Cmd+Click → toggle in the multi-selection
          const p = this.selRegions.indexOf(i);
          if (p >= 0) this.selRegions.splice(p, 1); else this.selRegions.push(i);
          this.selRegion = i; this.sel = this.regions[i] ? { ...this.regions[i] } : null;
          this.opts.onSelectRegions && this.opts.onSelectRegions(this.selRegions.map(k => this.regions[k]));
          this.render(); return;
        }
        if (e.shiftKey) {                    // shift+click: extend selection (adjacent only)
          if (this.selRegions.length) {
            const lo = Math.min(...this.selRegions), hi = Math.max(...this.selRegions);
            if (i === lo - 1 || i === hi + 1) { if (!this.selRegions.includes(i)) this.selRegions.push(i); }
            else if (!this.selRegions.includes(i)) toast("Shift+Click a section next to the selected one(s).");
          } else this.selRegions = [i];
          this.selRegion = i; this.sel = { ...this.regions[i] };
          this.opts.onSelectRegions && this.opts.onSelectRegions(this.selRegions.map(k => this.regions[k]));
          this.render(); return;
        }
        if (this.reorderable) {
          // BLOCK if this section is part of a multi-selection; else ALIGN a single one
          const block = this.selRegions.length > 1 && this.selRegions.includes(i);
          let set;
          if (block) {                       // auto-fill any unselected sections between the ends
            const lo = Math.min(...this.selRegions), hi = Math.max(...this.selRegions);
            this.selRegions = []; for (let k = lo; k <= hi; k++) this.selRegions.push(k);
            set = new Set(this.selRegions);
          } else { this.selRegions = [i]; this.selRegion = i; this.sel = { ...this.regions[i] }; set = new Set([i]); }
          this._adrag = { i, x0: e.clientX, moved: false, mode: block ? 2 : 1, set, orig: this.regions.map(r => ({ ...r })) };
          e.preventDefault(); return;
        }
        // non-reorderable tabs: arm the ripple body-drag (click-vs-drag resolved on move/up)
        this._rdrag = { di: i, x0: e.clientX, moved: false, orig: this.regions.map(r => ({ ...r })) };
        e.preventDefault(); return;
      }
      if (this.reorderable) {                                  // empty strip click → clear selection
        if (this.selRegions.length) { this.selRegions = []; this.selRegion = -1; this.sel = null; this.render(); }
        return;
      }
      this._rcreate = this._snapT(this._tAtClientX(e.clientX));   // empty strip → create (other tabs)
    };
    // double-click a region to rename it (founder: edit the text between the brackets)
    strip.ondblclick = e => {
      const el = e.target.closest(".region"); if (!el) return;
      const r = this.regions[+el.dataset.ri];
      el.innerHTML = `<input value="${r.label.replace(/"/g, "&quot;")}" style="width:95%;background:#101119;border:1px solid var(--accent2);color:var(--txt);border-radius:3px;font-size:8.5px;padding:0 2px">`;
      const inp = el.querySelector("input");
      inp.focus(); inp.select();
      const save = () => {
        const v = inp.value.trim();
        if (v) {
          r.label = v.replace(/^\[|\]$/g, ""); r.userEdited = true;
          // rewrite the matching [Section] header in the lyric document — the tag↔lyric bond
          this.opts.onRenameRegion && this.opts.onRenameRegion(+el.dataset.ri, r.label);
        }
        this.render();
      };
      inp.onkeydown = ev => { if (ev.key === "Enter") save(); if (ev.key === "Escape") this.render(); ev.stopPropagation(); };
      inp.onblur = save;
      inp.onmousedown = ev => ev.stopPropagation();
    };

    let laneIdx = -1;
    all.forEach(l => {
      laneIdx++;
      const row = this.scrollEl.children[laneIdx + 2];
      const tlEl = row.querySelector(".laneTL");
      if (l.composite) this._drawComposite(tlEl);
      else if (l.peaks || l.buffer) this._drawWave(tlEl, l);
      // press-tracking: a CLICK (no real drag) always seeks; a drag past 4px makes a
      // selection. The threshold is in PIXELS, not seconds, so it works at every zoom —
      // a time threshold went sub-pixel when zoomed out and ate ~1/10 clicks as "drags".
      let press = null;
      tlEl.onmousedown = e => {
        if (this._anchorArm) { e.preventDefault(); e.stopPropagation(); this.setAnchorAt(e.clientX); return; }
        press = { x0: e.clientX, t0: this._tAtClientX(e.clientX), moved: false };
        this.selectedLane = l;
      };
      tlEl.onmousemove = e => {
        if (!press) return;
        if (!press.moved && Math.abs(e.clientX - press.x0) < 4) return;   // ignore sub-4px jitter
        press.moved = true;
        const t = this._tAtClientX(e.clientX);
        this.sel = { start: this._snapGrid(Math.min(press.t0, t)), end: this._snapGrid(Math.max(press.t0, t)) };
        this._paintSel(); this._selText();
      };
      tlEl.onmouseup = e => {
        if (!press) return;
        const raw = this._snapGrid(this._tAtClientX(e.clientX));      // snap the playhead to the grid
        this.clockEl.innerHTML = `&#128337; ${fmt(raw)}.${String(Math.floor((raw % 1) * 1000)).padStart(3, "0")}`;
        if (!press.moved) { this.sel = null; this.opts.onSeek && this.opts.onSeek(raw); }   // genuine click → seek
        press = null; this.render();
      };
      row.querySelectorAll("[data-tg]").forEach(b => b.onclick = e => {
        e.stopPropagation();
        if (b.dataset.tg === "closecomp") {
          this.showComposite = false;
          sessionStorage.setItem("ams.composite." + location.pathname, "closed");
          this.render(); return;
        }
        if (b.dataset.tg === "lselect") {   // select this clip's entire audio region
          this.selectedLane = l;
          const end = l.buffer ? l.buffer.duration
                    : (l.peaks && l.peaks.duration_s) ? l.peaks.duration_s : this.duration;
          this.sel = { start: 0, end: Math.min(end, this.duration) || this.duration };
          this.render(); return;
        }
        this.opts.onToggle && this.opts.onToggle(l, b.dataset.tg);
      });
      const gl = row.querySelector(".glabel");
      gl.onclick = e => {
        if (e.target.dataset && e.target.dataset.tg) return;   // buttons handled above
        this.selectedLane = l; this.render();
        this.opts.onToggle && this.opts.onToggle(l, "select");
      };
    });
    if (!this.showComposite) this._compReopen();
    this._paintSel(); this._selText();
  }

  _compReopen() {
    let b = this.bar.querySelector(".compreopen");
    if (!b) {
      b = document.createElement("button");
      b.className = "tool compreopen"; b.innerHTML = "&#10133; Composite";
      b.onclick = () => { this.showComposite = true;
        sessionStorage.setItem("ams.composite." + location.pathname, "open"); b.remove(); this.render(); };
      this.bar.appendChild(b);
    }
  }

  _laneHtml(l, w) {
    const extras = (!l.composite && this.opts.laneExtras) ? this.opts.laneExtras(l) : "";
    return `<div class="lane ${l.composite ? "composite" : ""} ${l.muted ? "muted" : ""} ${this.selectedLane === l ? "seltgt" : ""} ${l.armed ? "armed" : ""}">
      <div class="glabel"><span class="dot" style="background:${l.color || "#7c5cff"}"></span>
        <span class="nm" title="${l.label}">${l.label}</span>
        ${l.composite
          ? `<span class="sm">${this.opts.armable ? `<button class="arm ${l.armed ? "on" : ""}" data-tg="arm" title="arm composite for edit">&#9678;</button>` : ""}<button data-tg="csolo" title="solo composite" class="solo ${l.solo ? "on" : ""}">S</button>
             <button data-tg="cmute" title="mute composite" class="mute ${l.muted ? "on" : ""}">M</button>
             <button data-tg="cselect" title="select entire composite">&#9635;</button>
             <button data-tg="cload" title="load a track into the composite">&#10133;</button>
             <button data-tg="cclear" title="clear composite clips">&#128465;</button>
             <button data-tg="cmidi" title="convert to MIDI (planned)">&#9836;</button>
             <button data-tg="closecomp" title="close composite">&#10005;</button></span>`
          : `<span class="sm">
              ${this.opts.armable ? `<button class="arm ${l.armed ? "on" : ""}" data-tg="arm" title="arm for edit">&#9678;</button>` : ""}
              ${l.hasAB ? `<button class="ab ${l.abOn ? "on" : ""}" data-tg="ab">AB</button>` : ""}
              <button class="solo ${l.solo ? "on" : ""}" data-tg="solo">S</button>
              <button class="mute ${l.muted ? "on" : ""}" data-tg="mute">M</button>
              <button data-tg="lselect" title="select entire track">&#9635;</button></span>${extras}`}
      </div>
      <div class="laneTL" style="width:${w}px">
        ${l.composite && !this.compositeSegs.length
          ? `<div class="emptyTL">Scratch pad — copy a region from a lane, then Paste here. Chop, solo, export, or send to the splitter.</div>`
          : `<canvas></canvas>`}
      </div></div>`;
  }

  _paintSel() {
    this.scrollEl.querySelectorAll(".tlsel").forEach(s => s.remove());
    if (!this.duration) return;
    const regionSel = this.reorderable && this.selRegions && this.selRegions.length;
    // ONE highlight rect PER selected region — so an unselected gap between two selected
    // tags stays un-highlighted (it only fills in when an action that needs contiguity runs:
    // Loop / Copy / Cut / Duplicate auto-add the in-between tags first).
    let rects = [];
    if (regionSel) {
      rects = this.selRegions.map(k => this.regions[k]).filter(Boolean)
        .map(r => [this._xo(r.start), this._xo(r.end)]);
    } else if (this.sel) {
      rects = [[this._x(this.sel.start), this._x(this.sel.end)]];   // free drag-selection (audio time)
    } else return;
    this.scrollEl.querySelectorAll(".lane").forEach(row => {
      if (!regionSel && !this.allLanes && !row.classList.contains("seltgt")) return;
      const tl = row.querySelector(".laneTL");
      rects.forEach(([a, b]) => {
        const s = document.createElement("div");
        s.className = "tlsel";
        s.style.left = (a - this.LBL) + "px"; s.style.width = Math.max(2, b - a) + "px";
        tl.appendChild(s);
      });
    });
  }
  /* expand the region selection to a contiguous run (fill any unselected gaps between the
     ends). Called by actions that require contiguity: Loop / Copy / Cut / Duplicate. */
  _fillSelectionGaps() {
    if (!this.selRegions || this.selRegions.length < 2) return;
    const lo = Math.min(...this.selRegions), hi = Math.max(...this.selRegions);
    const full = []; for (let k = lo; k <= hi; k++) full.push(k);
    this.selRegions = full;
  }
  _selText() {
    // while looping, report the FULL looped span (all selected sections), not just
    // the last-clicked one — otherwise a multi-section loop reads as a single region
    const seg = (this.loop && this.getLoop()) || this.sel;
    if (!seg) { this.selInfo.textContent = ""; return; }
    const spb = this._secPerBar();
    this.selInfo.textContent =
      `bars ${(seg.start / spb + 1).toFixed(1)}–${(seg.end / spb + 1).toFixed(1)}` +
      ` (${fmt(seg.start)}–${fmt(seg.end)})${this.loop ? " · looping" : ""}`;
  }
  /* ---- bar-length dropdown (4/8/16/32/custom) on a region's bars chip ---- */
  _closeBarsMenu() {
    if (this._barsMenuEl) { this._barsMenuEl.remove(); this._barsMenuEl = null; }
    if (this._barsMenuOff) { document.removeEventListener("mousedown", this._barsMenuOff, true); this._barsMenuOff = null; }
  }
  _openBarsMenu(i, x, y) {
    this._closeBarsMenu();
    const r = this.regions[i]; if (!r) return;
    const cur = (r.bars != null) ? r.bars : r.lenBars;
    const m = document.createElement("div"); m.className = "barsmenu";
    m.innerHTML = [4, 8, 16, 32].map(b => `<div class="bmopt${b === cur ? " on" : ""}" data-b="${b}">${b} bars</div>`).join("")
      + `<div class="bmopt bmcustom" data-b="custom">Custom…</div>`;
    document.body.appendChild(m);
    m.style.left = Math.min(window.innerWidth - 140, Math.max(6, x)) + "px";
    m.style.top = Math.min(window.innerHeight - 190, y + 4) + "px";
    m.querySelectorAll(".bmopt").forEach(el => el.onmousedown = ev => {
      ev.preventDefault(); ev.stopPropagation();
      const v = el.dataset.b; this._closeBarsMenu();
      if (v === "custom") {
        const ask = (window.askText)
          ? window.askText({ title: "Custom bar length", sub: "How many bars should this section span?", value: String(cur || 4), placeholder: "e.g. 24", okLabel: "Set bars" })
          : Promise.resolve(prompt("Bars:", String(cur || 4)));
        ask.then(res => { const n = parseInt(res, 10); if (n > 0) this.opts.onSetRegionBars && this.opts.onSetRegionBars(i, n); });
      } else {
        this.opts.onSetRegionBars && this.opts.onSetRegionBars(i, +v);
      }
    });
    this._barsMenuEl = m;
    // click anywhere else closes it (capture so it runs before strip handlers)
    this._barsMenuOff = ev => { if (!m.contains(ev.target)) this._closeBarsMenu(); };
    setTimeout(() => document.addEventListener("mousedown", this._barsMenuOff, true), 0);
  }

  _drawWave(tlEl, lane) {
    const c = tlEl.querySelector("canvas"); if (!c) return;
    // drive the canvas off the EXACT grid width (_width), not clientWidth, so the
    // waveform and the beat grid share one coordinate space and never drift.
    const w = c.width = this._width(), h = c.height = tlEl.clientHeight;
    const g = c.getContext("2d");
    g.strokeStyle = lane.color || "#7c5cff"; g.globalAlpha = .85; g.lineWidth = 1;
    const p = lane.peaks;
    if (p && p.tiers) {
      const tiers = Object.keys(p.tiers).map(Number).sort((a, b) => a - b);
      let tier = tiers[tiers.length - 1];
      for (const t of tiers) if (p.tiers[t].max.length <= w * 2) { tier = t; break; }
      const { min, max } = p.tiers[tier], n = max.length;
      g.beginPath();
      for (let x = 0; x < w; x++) {
        const a = Math.floor(x * n / w), b = Math.max(a + 1, Math.floor((x + 1) * n / w));
        let lo = 127, hi = -127;
        for (let i = a; i < b && i < n; i++) { lo = Math.min(lo, min[i]); hi = Math.max(hi, max[i]); }
        g.moveTo(x + .5, h / 2 - (hi / 127) * (h / 2 - 3));
        g.lineTo(x + .5, h / 2 - (lo / 127) * (h / 2 - 3));
      }
      g.stroke();
    } else if (lane.buffer) {
      // map each pixel column x to the EXACT sample range [x·n/w, (x+1)·n/w) — the same
      // time→pixel mapping the grid uses — so a transient lands on its true bar/beat at
      // every zoom (the old ceil-step accumulated a position-dependent drift).
      const d = lane.buffer.getChannelData(0), n = d.length;
      g.beginPath();
      for (let x = 0; x < w; x++) {
        const a = Math.floor(x * n / w), z = Math.min(n, Math.floor((x + 1) * n / w));
        const stride = Math.max(1, Math.floor((z - a) / 8));
        let lo = 1, hi = -1;
        for (let i = a; i < z; i += stride) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (lo > hi) { lo = 0; hi = 0; }
        g.moveTo(x + .5, h / 2 - hi * (h / 2 - 3));
        g.lineTo(x + .5, h / 2 - lo * (h / 2 - 3));
      }
      g.stroke();
    }
  }

  _drawComposite(tlEl) {
    const c = tlEl.querySelector("canvas"); if (!c) return;
    const w = c.width = tlEl.clientWidth, h = c.height = tlEl.clientHeight;
    const g = c.getContext("2d");
    for (const seg of this.compositeSegs) {
      const x1 = (seg.start / this.duration) * w, x2 = ((seg.start + seg.dur) / this.duration) * w;
      g.fillStyle = "#19d3c533"; g.fillRect(x1, 3, Math.max(2, x2 - x1), h - 6);
      g.strokeStyle = "#19d3c5"; g.strokeRect(x1 + .5, 3.5, Math.max(2, x2 - x1) - 1, h - 7);
      g.fillStyle = "#19d3c5"; g.font = "9px Inter, sans-serif";
      g.fillText(seg.label || "", x1 + 4, 14);
    }
  }
}
