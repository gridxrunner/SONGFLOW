/* AI Music Suite — Lyric core (standalone). The word processor, rhyme engine,
   prediction, stats, doc management. Shares globals (doc, gut, tl, cur, curBuf,
   detectedBpm, curKey, rhymeOn, tagRegions, toast, $) with index.html. */

/* ---- document management (localStorage; multi-doc) ---- */
const DEFAULT=`[Verse 1]\nType your lyrics here\nEvery line shows its syllables\nLine-end rhymes light up in color\nSo your scheme stays clear\n\n[Chorus]\n...`;
const DOCS_KEY="ams.lyrics.docs",TKEY="ams.lyrics.syltarget";
function loadDocs(){
  try{
    const d=JSON.parse(localStorage.getItem(DOCS_KEY));
    if(d&&Array.isArray(d.docs)&&d.docs.length){
      d.active=Math.min(Math.max(+d.active||0,0),d.docs.length-1);
      const t=localStorage.getItem("ams.lyrics");
      if(t!==null)d.docs[d.active].text=t;
      return d;
    }
  }catch{}
  return {active:0,docs:[{name:"Lyrics 1",text:localStorage.getItem("ams.lyrics")||DEFAULT,updated:0}]};
}
let docsState=loadDocs();
function saveDocs(){localStorage.setItem(DOCS_KEY,JSON.stringify(docsState));}
const newId=()=>"p"+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
docsState.docs.forEach(d=>{if(!d.id)d.id=newId();});saveDocs();   // stable per-project id (keys the saved audio)
function activeDocId(){const d=docsState.docs[docsState.active];if(d&&!d.id){d.id=newId();saveDocs();}return d?d.id:null;}
function syncDocSel(){
  const s=$("docSel");s.innerHTML="";
  docsState.docs.forEach((d,i)=>{const o=document.createElement("option");o.value=i;o.textContent=d.name;s.appendChild(o);});
  s.value=docsState.active;
}
function switchDoc(i){
  if(i===docsState.active||!docsState.docs[i])return;
  docsState.docs[docsState.active].text=doc.innerText;
  if(typeof saveProjectState==="function")saveProjectState();   // stash the current project's audio settings
  docsState.active=i;saveDocs();
  doc.textContent=docsState.docs[i].text;selLine=-1;
  if(rhymeOn)paintRhymes();else update();
  syncDocSel();
  if(typeof restoreProjectState==="function")restoreProjectState();   // bring back the new project's audio + settings
}
$("docSel").onchange=()=>switchDoc(+$("docSel").value);
$("docNew").onclick=async()=>{
  const def=`Project ${docsState.docs.length+1}`;
  const name=(typeof askText==="function")
    ? await askText({title:"New project",sub:"Give this project a name.",value:def,placeholder:"Project name",okLabel:"＋ Create project"})
    : prompt("New project name:",def);
  if(name===null)return;
  docsState.docs.push({name:name.trim()||def,text:"[Verse 1]\n",updated:0,id:newId()});
  saveDocs();switchDoc(docsState.docs.length-1);
};
$("docRen").onclick=async()=>{
  const d=docsState.docs[docsState.active];
  const name=(typeof askText==="function")
    ? await askText({title:"Rename project",value:d.name,placeholder:"Project name",okLabel:"Save"})
    : prompt("Rename project:",d.name);
  if(name===null||!name.trim())return;
  d.name=name.trim();saveDocs();syncDocSel();
};
$("docDel").onclick=()=>{
  const d=docsState.docs[docsState.active];
  if(!confirm(`Delete "${d.name}"? Its text is removed permanently.`))return;
  docsState.docs.splice(docsState.active,1);
  if(!docsState.docs.length)docsState.docs.push({name:"Lyrics 1",text:"",updated:0});
  docsState.active=Math.min(docsState.active,docsState.docs.length-1);
  saveDocs();doc.textContent=docsState.docs[docsState.active].text;selLine=-1;
  if(rhymeOn)paintRhymes();else update();syncDocSel();
};
doc.textContent=docsState.docs[docsState.active].text;

/* ---- syllables / vowels ---- */
function syllables(word){
  let w=word.toLowerCase().replace(/[^a-z']/g,"");
  if(!w)return 0;
  // EXACT count from CMUdict (126k words) — stress pattern length = syllable count
  if(typeof PRON!=="undefined"){const p=PRON[w]||(w.indexOf("'")>=0?PRON[w.replace(/'/g,"")]:null); if(p)return p.length;}
  w=w.replace(/'/g,""); if(!w)return 0;
  // heuristic fallback for words not in the dictionary (names, slang, coinages)
  w=w.replace(/([^aeiouy])e(s?)$/,"$1");          // silent final -e / -es after a consonant: leaves→leav, makes→mak
  w=w.replace(/([^aeioudt])ed$/,"$1");             // silent -ed except after t/d: played→play, loved→lov
  const m=w.match(/[aeiouy]{1,2}/g);               // a diphthong (oe, ea…) counts as one
  return Math.max(1,(m||[]).length);
}
/* stress pattern for a word ("101" = primary,unstressed,primary), from CMUdict — '' if unknown.
   Feeds the beat/pocket model: which syllables are strong, used to place the rhyme on a strong beat. */
function stressOf(word){const w=String(word||"").toLowerCase().replace(/[^a-z']/g,"");if(typeof PRON==="undefined")return"";return PRON[w]||(w.indexOf("'")>=0?PRON[w.replace(/'/g,"")]:"")||"";}
function endVowelKey(word){
  word=word.toLowerCase().replace(/[^a-z]/g,"");
  const m=word.match(/[aeiouy]+[^aeiouy]*$/);
  return m?m[0].replace(/[^aeiouy]/g,""):null;
}
const STOP=new Set(["the","a","an","to","of","in","on","it","is","at","as","and","or","but","for","so","we","he","she","you","me","my","be","do","no","by","up","if","its","his","her","our","was","are","this","that","with","not"]);
const isTag=t=>/^\[.*\]$/.test(t);

/* ---- RHYME ANCHOR ----
   The rhyme of a bar normally sits on its LAST word — but a comma (or ; :) near the end marks
   the trailing word(s) as a PICKUP that leads into the next bar, so the real rhyme is the last
   word BEFORE that comma. e.g. "ain't nobody else, just" rhymes on "else" (EH), not the pickup
   "just" (AH); "We were hanging out, in a" rhymes on "out" (AW), not "a". This single rule
   feeds the gutter, colors, scheme map, bar guidance, and the generator. */
function rhymeAnchorIdx(words){
  if(!words.length)return -1;
  const last=words.length-1;
  for(let i=last-1;i>=0&&i>=last-2;i--){                 // a comma within ~2 words of the end
    if(/[,;:]$/.test(words[i])){
      const tail=words.slice(i+1);
      const tailSyl=tail.reduce((n,w)=>n+syllables(w),0);
      if(tailSyl<=2)return i;                            // short pickup → anchor is the pre-comma word
    }
  }
  return last;
}
function rhymeAnchorWord(line){
  const words=(line||"").trim().split(/\s+/).filter(Boolean);
  const idx=rhymeAnchorIdx(words);
  return idx>=0?words[idx].replace(/[,;:]+$/,""):"";
}

function rhymeFams(lines){
  const fams={};let next=0;const cnt={};
  for(const l of lines){const t=l.trim();if(!t||isTag(t))continue;
    const key=endVowelKey(rhymeAnchorWord(t));if(!key)continue;
    if(!(key in fams))fams[key]=next++;cnt[key]=(cnt[key]||0)+1;}
  return {fams,cnt};
}
function schemeLetters(lines){
  const keys=lines.map(l=>{const t=l.trim();if(!t||isTag(t))return null;return endVowelKey(rhymeAnchorWord(t));});
  const out=new Array(lines.length).fill("");let secIdx=[];
  const flush=()=>{const cnt={};secIdx.forEach(i=>{if(keys[i])cnt[keys[i]]=(cnt[keys[i]]||0)+1;});
    const map={};let n=0;secIdx.forEach(i=>{const k=keys[i];
      if(k&&cnt[k]>=2){if(!(k in map))map[k]=String.fromCharCode(65+(n++%26));out[i]=map[k];}});secIdx=[];};
  lines.forEach((l,i)=>{const t=l.trim();if(isTag(t))flush();else if(t)secIdx.push(i);});flush();
  return out;
}

let tagTimer=null;
function update(){
  const lines=doc.innerText.split("\n");
  const target=+(localStorage.getItem(TKEY)||0);let bar=0;
  gut.innerHTML=lines.map((l)=>{const t=l.trim();if(!t||isTag(t))return "";bar++;
    const syl=sylOfBar(t);                                  // CORE count — a trailing lead-in/pickup doesn't add to it
    const s=target&&syl>target?`<span class="over">${syl}</span>`:String(syl);
    const vc=vowelClass(rhymeAnchorWord(t));
    return `${bar} │ ${s}${vc?` <span class="sch">${vc}</span>`:""}`;}).join("\n");
  localStorage.setItem("ams.lyrics",doc.innerText);
  const d=docsState.docs[docsState.active];d.text=doc.innerText;saveDocs();
  renderStats();renderSchemeMap();refreshLinePanels();
  try{updateFlowHud();}catch{}
  clearTimeout(tagTimer);tagTimer=setTimeout(()=>{try{tagRegions();}catch{}},600);
}
function paintRhymes(){
  const lines=doc.innerText.split("\n");const {fams,cnt}=rhymeFams(lines);
  const html=lines.map(l=>{const tt=l.trim();
    if(!tt)return esc(l);
    if(isTag(tt))return esc(l).replace(/\[[^\]]*\]/,m=>`<span class="sect">${m}</span>`);
    const toks=l.split(/(\s+)/);
    // colour the RHYME ANCHOR token (last word before a trailing pickup), not necessarily the last word
    const wordToks=[];toks.forEach((w,i)=>{if(w.trim())wordToks.push(i);});
    const aIdx=rhymeAnchorIdx(wordToks.map(i=>toks[i]));const last=aIdx>=0?wordToks[aIdx]:-1;
    return toks.map((w,i)=>{if(!w.trim())return w;const key=endVowelKey(w);
      if(i===last)return key&&(key in fams)?`<span class="r${fams[key]%6}">${esc(w)}</span>`:esc(w);
      const clean=w.toLowerCase().replace(/[^a-z]/g,"");
      if(key&&(key in fams)&&cnt[key]>=2&&clean.length>=3&&!STOP.has(clean))return `<span class="r${fams[key]%6} in">${esc(w)}</span>`;
      return esc(w);}).join("");
  }).join("\n");
  doc.innerHTML=html;update();
}
function esc(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;");}
function unpaint(){doc.textContent=doc.innerText;update();}
doc.addEventListener("input",update);
/* ---- caret <-> flat-text offset (robust across painted spans) ---- */
function caretOffset(){
  const s=document.getSelection();if(!s.rangeCount||!doc.contains(s.anchorNode))return null;
  const r=s.getRangeAt(0).cloneRange();r.collapse(true);
  const pre=document.createRange();pre.selectNodeContents(doc);
  try{pre.setEnd(r.startContainer,r.startOffset);}catch{return null;}
  return pre.toString().length;
}
function offsetOf(node,nodeOffset){
  const pre=document.createRange();pre.selectNodeContents(doc);
  try{pre.setEnd(node,nodeOffset);}catch{return null;}
  return pre.toString().length;
}
function setCaret(offset){
  const walk=document.createTreeWalker(doc,NodeFilter.SHOW_TEXT,null);
  let n,rem=offset;
  while(n=walk.nextNode()){const len=n.nodeValue.length;
    if(rem<=len){const sel=document.getSelection(),r=document.createRange();
      r.setStart(n,rem);r.collapse(true);sel.removeAllRanges();sel.addRange(r);return;}
    rem-=len;}
  const sel=document.getSelection(),r=document.createRange();
  r.selectNodeContents(doc);r.collapse(false);sel.removeAllRanges();sel.addRange(r);
}
doc.addEventListener("keydown",e=>{
  if(e.key==="Enter"){e.preventDefault();document.execCommand("insertText",false,"\n");return;}
  // Painted spans block the browser's forward-delete at their boundary. When rhyme
  // colors are on, run Delete/Backspace on the flat text model and restore the caret.
  if((e.key==="Delete"||e.key==="Backspace")&&rhymeOn){
    const sel=document.getSelection();if(!sel.rangeCount)return;
    const text=doc.innerText;let start,end;
    if(!sel.isCollapsed){
      const a=offsetOf(sel.anchorNode,sel.anchorOffset),b=offsetOf(sel.focusNode,sel.focusOffset);
      if(a==null||b==null)return;start=Math.min(a,b);end=Math.max(a,b);
    }else{
      const off=caretOffset();if(off==null)return;
      if(e.key==="Delete"){start=off;end=off+1;}else{start=off-1;end=off;}
    }
    if(start<0)start=0;if(end>text.length)end=text.length;
    e.preventDefault();
    if(start>=end)return;                              // nothing to delete (e.g. at doc end)
    const next=text.slice(0,start)+text.slice(end);
    doc.textContent=next;paintRhymes();setCaret(start);  // repaint keeps colors, caret restored
  }
});
doc.addEventListener("paste",e=>{e.preventDefault();const t=(e.clipboardData||window.clipboardData).getData("text");document.execCommand("insertText",false,t);
  // repaint so pasted lines get correct rhyme colors immediately (don't inherit the caret span's color)
  if(rhymeOn){const off=(typeof caretOffset==="function")?caretOffset():null;paintRhymes();if(off!=null&&typeof setCaret==="function")setCaret(off);}else update();});
$("lRhyme").onclick=()=>{rhymeOn=!rhymeOn;if(rhymeOn)paintRhymes();else unpaint();};
$("lClear").onclick=()=>{if(confirm("Clear the document? You can undo with Ctrl+Z.")){pushUndo();doc.textContent="";update();}};
/* ---- insert an arrangement tag at the caret (on its own line) ---- */
const TAGS=["Intro","Verse","Verse 1","Verse 2","Pre-Chorus","Chorus","Post-Chorus","Hook","Bridge","Build-Up","Drop","Breakdown","Instrumental Break","Interlude","Outro"];
$("tagIns").onchange=()=>{
  const v=$("tagIns").value;$("tagIns").value="";if(!v)return;
  doc.focus();
  const text=doc.innerText;
  let off=(typeof caretOffset==="function"&&caretOffset()!=null)?caretOffset():text.length;
  let ins="["+v+"]";
  const before=text.slice(0,off),after=text.slice(off);
  if(before&&!before.endsWith("\n"))ins="\n"+ins;
  if(after&&!after.startsWith("\n"))ins=ins+"\n";
  const next=before+ins+after;
  // keep the OTHER sections where the user placed them: splice a null position in at
  // the new tag's order index instead of letting tagRegions reset everything.
  if(typeof manualBars!=="undefined"&&manualBars)manualBars.splice((before.match(/^\s*\[.+\]\s*$/gm)||[]).length,0,null);
  doc.textContent=next;
  if(rhymeOn)paintRhymes();else update();
  if(typeof setCaret==="function")setCaret((before+ins).length);
};
/* ---- tag autocomplete: typing "[" opens a menu; pick one and the full [Tag] is
   inserted. Type to filter, ↑/↓ to move, Enter/Tab to accept, Esc to dismiss. ---- */
let tagMenuIdx=0,tagMenuList=[];
function hideTagMenu(){const m=$("tagMenu");if(m)m.style.display="none";tagMenuList=[];}
function tagQueryAtCaret(){
  const off=caretOffset();if(off==null)return null;
  const text=doc.innerText;
  let i=off-1;for(;i>=0;i--){const c=text[i];if(c==="]"||c==="\n")return null;if(c==="[")break;}
  if(i<0)return null;
  const query=text.slice(i+1,off);
  if(/[\]\n[]/.test(query))return null;          // bail if a second bracket sneaks in
  return {open:i,query};
}
function showTagMenu(){
  const m=$("tagMenu");if(!m)return;
  const ctx=tagQueryAtCaret();if(!ctx){hideTagMenu();return;}
  const q=ctx.query.toLowerCase();
  let list=q?TAGS.filter(t=>t.toLowerCase().startsWith(q)):TAGS.slice();
  if(q&&!list.length)list=TAGS.filter(t=>t.toLowerCase().includes(q));
  if(!list.length){hideTagMenu();return;}
  tagMenuList=list;if(tagMenuIdx>=list.length)tagMenuIdx=0;if(tagMenuIdx<0)tagMenuIdx=0;
  m.innerHTML=list.map((t,k)=>`<div class="tagopt${k===tagMenuIdx?' on':''}" data-k="${k}">[${esc(t)}]</div>`).join("");
  let x=40,y=120;const s=document.getSelection();
  if(s&&s.rangeCount){const r=s.getRangeAt(0).cloneRange();r.collapse(true);const rect=r.getBoundingClientRect();if(rect.left||rect.bottom){x=rect.left;y=rect.bottom;}}
  m.style.display="block";
  m.style.left=Math.min(window.innerWidth-170,Math.max(6,x))+"px";
  m.style.top=Math.min(window.innerHeight-150,y+4)+"px";
  m.querySelectorAll(".tagopt").forEach(el=>el.onmousedown=ev=>{ev.preventDefault();acceptTag(+el.dataset.k);});
}
function acceptTag(k){
  const ctx=tagQueryAtCaret();if(!ctx){hideTagMenu();return;}
  const tag=tagMenuList[k!=null?k:tagMenuIdx];if(!tag){hideTagMenu();return;}
  const text=doc.innerText,off=caretOffset();
  // swallow the WHOLE bracket token being typed — from "[" up to its "]" (or end of line) —
  // so picking "[Verse 2]" over a half-typed "[Verse 2" doesn't leave a stray " 2]" behind.
  let end=off;while(end<text.length&&text[end]!=="]"&&text[end]!=="\n")end++;
  if(text[end]==="]")end++;
  const before=text.slice(0,ctx.open),after=text.slice(end),ins="["+tag+"]";
  if(typeof manualBars!=="undefined"&&manualBars)manualBars.splice((before.match(/^\s*\[.+\]\s*$/gm)||[]).length,0,null);
  doc.textContent=before+ins+after;
  if(rhymeOn)paintRhymes();else update();
  setCaret((before+ins).length);hideTagMenu();
}
doc.addEventListener("input",()=>{try{showTagMenu();}catch{}});
doc.addEventListener("keydown",e=>{                        // capture-phase: intercept nav keys while the menu is open
  const m=$("tagMenu");if(!m||m.style.display==="none"||!tagMenuList.length)return;
  if(e.key==="ArrowDown"){e.preventDefault();e.stopImmediatePropagation();tagMenuIdx=(tagMenuIdx+1)%tagMenuList.length;showTagMenu();}
  else if(e.key==="ArrowUp"){e.preventDefault();e.stopImmediatePropagation();tagMenuIdx=(tagMenuIdx-1+tagMenuList.length)%tagMenuList.length;showTagMenu();}
  else if(e.key==="Enter"||e.key==="Tab"){e.preventDefault();e.stopImmediatePropagation();acceptTag();}
  else if(e.key==="Escape"){e.preventDefault();e.stopImmediatePropagation();hideTagMenu();}
},true);
doc.addEventListener("blur",()=>setTimeout(hideTagMenu,120));
/* ---- arrangement ↔ lyrics: the timeline regions are permanently linked to the lyric
   document. A section "block" is a [Tag] line plus every line beneath it up to the
   next [Tag]. Content before the first tag (preamble) stays pinned at the top.
   Drag/delete on the timeline rewrites these blocks; the doc's top-to-bottom order
   always matches the strip's left-to-right order. */
function sectionBlocks(){
  const lines=doc.innerText.split("\n");
  const pre=[];const blocks=[];let cur=null;
  for(const l of lines){
    if(isTag(l.trim())){cur={lines:[l]};blocks.push(cur);}
    else if(cur)cur.lines.push(l);
    else pre.push(l);
  }
  return {pre,blocks};
}
const _trimTrail=ls=>{const a=ls.slice();while(a.length&&!a[a.length-1].trim())a.pop();return a;};
/* ---- structural undo: native contenteditable undo can't reach programmatic changes
   (delete region, rearrange, bar-length), so snapshot {text, positions} before each one
   and restore on Ctrl+Z. ---- */
let undoStack=[], redoStack=[], _genSeq=0;   // _genSeq: bump to CANCEL an in-flight generation (e.g. on undo)
// true once the user has typed into the lyric box since the last STRUCTURAL action. While true,
// Ctrl+Z in the box defers to the editor's native char-by-char undo; while false, our stack owns
// the last change (a generation, fill, grid/warp/BPM/audio edit, etc.) so ALL of them are undoable.
let typedSinceStructural=false;
function _undoSnap(){return {
  text:doc.innerText,
  caret:(typeof caretOffset==="function")?caretOffset():null,   // keep the cursor near where it was (don't jump to top)
  manualBars:(typeof manualBars!=="undefined"&&manualBars)?manualBars.slice():null,
  ga:(typeof gridAnchor!=="undefined")?gridAnchor:undefined, gs:(typeof gridSlip!=="undefined")?gridSlip:undefined,
  warp:(typeof warpMarkers!=="undefined"&&warpMarkers)?warpMarkers.slice():undefined,
  bpm:(typeof tl!=="undefined"&&tl)?tl.bpm:undefined,
  audioBuf:(typeof curBuf!=="undefined")?curBuf:undefined   // reference only (buffers are never mutated in place)
};}
function _undoRestore(s){
  doc.textContent=s.text;
  if(typeof manualBars!=="undefined")manualBars=s.manualBars?s.manualBars.slice():null;
  if(s.bpm!==undefined&&typeof tl!=="undefined"&&tl.bpm!==s.bpm){tl.setTempo(s.bpm);if(typeof detectedBpm!=="undefined")detectedBpm=s.bpm;if(typeof renderBpmReadout==="function")renderBpmReadout();}
  if(s.ga!==undefined&&typeof gridAnchor!=="undefined"){gridAnchor=s.ga;gridSlip=s.gs;}
  if(s.warp!==undefined&&typeof warpMarkers!=="undefined"){warpMarkers=s.warp?s.warp.slice():[];if(typeof applyWarp==="function")applyWarp(false);}
  if(typeof applyGrid==="function")applyGrid(false);
  if(s.audioBuf!==undefined&&typeof restoreAudioBuffer==="function")restoreAudioBuffer(s.audioBuf);
  if(rhymeOn)paintRhymes();else update();
  if(s.caret!=null&&typeof setCaret==="function"){try{setCaret(Math.min(s.caret,doc.innerText.length));}catch(e){}}   // restore cursor position
  try{tagRegions();}catch{}
  if(typeof tl!=="undefined"){tl.selRegions=[];tl.selRegion=-1;tl.sel=null;tl.render();}
  if(typeof saveProjectState==="function")saveProjectState();
  typedSinceStructural=false; _syncUndoBtns();
  // CANCEL any in-flight generation — its async fill must NOT land on the restored document
  _genSeq++; if(typeof genGlowHide==="function")genGlowHide(); if($("ideaGo"))$("ideaGo").disabled=false;
}
function _syncUndoBtns(){const u=$("undoBtn"),r=$("redoBtn");if(u)u.disabled=!undoStack.length;if(r)r.disabled=!redoStack.length;}
function pushUndo(){try{undoStack.push(_undoSnap()); redoStack=[];   // a new action invalidates the redo trail
  if(undoStack.length>60)undoStack.shift();
  // bound memory: a decoded buffer is 100+ MB. Keep only the most recent DISTINCT buffers restorable.
  const seen=[];for(const s of undoStack)if(s.audioBuf&&seen.indexOf(s.audioBuf)<0)seen.push(s.audioBuf);
  if(seen.length>8){const drop=seen.slice(0,seen.length-8);for(const s of undoStack)if(s.audioBuf&&drop.indexOf(s.audioBuf)>=0)s.audioBuf=undefined;}
  typedSinceStructural=false; _syncUndoBtns();
}catch(e){}}
function doUndo(){
  if(!undoStack.length){if(typeof toast==="function")toast("Nothing to undo");return;}
  redoStack.push(_undoSnap()); _undoRestore(undoStack.pop());
  if(typeof toast==="function")toast("Undone");
}
function doRedo(){
  if(!redoStack.length){if(typeof toast==="function")toast("Nothing to redo");return;}
  undoStack.push(_undoSnap()); _undoRestore(redoStack.pop());
  if(typeof toast==="function")toast("Redone");
}
// Ctrl/Cmd+Z: structural undo for everything our stack tracks. Inside the lyric box, defer to the
// editor's native undo ONLY while the user is mid-typing (so char-undo still feels normal); the
// moment a structural action happens (no typing since), our stack takes over even with the box focused.
document.addEventListener("keydown",e=>{
  const z=(e.key==="z"||e.key==="Z"), y=(e.key==="y"||e.key==="Y");
  if((e.ctrlKey||e.metaKey)&&((z&&e.shiftKey)||y)){e.preventDefault();doRedo();return;}   // redo: Ctrl+Shift+Z / Ctrl+Y
  if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&z){
    if(document.activeElement===doc){
      if(typedSinceStructural||!undoStack.length)return;                // typed since → native char undo
      e.preventDefault();doUndo();return;                              // last change was structural → our stack
    }
    if(undoStack.length){e.preventDefault();doUndo();}
  }
},true);
// real typing/paste in the box flips us into native-undo mode; leaving the box hands control back
doc.addEventListener("input",()=>{typedSinceStructural=true;});
doc.addEventListener("blur",()=>{typedSinceStructural=false;});
if($("undoBtn"))$("undoBtn").onclick=()=>doUndo();
if($("redoBtn"))$("redoBtn").onclick=()=>doRedo();
_syncUndoBtns();
function _writeDoc(pre,orderedBlocks){
  const parts=[];const preT=_trimTrail(pre);if(preT.length)parts.push(preT.join("\n"));
  orderedBlocks.forEach(b=>parts.push(_trimTrail(b.lines).join("\n")));
  doc.textContent=parts.join("\n\n");           // one blank line between sections
  if(rhymeOn)paintRhymes();else update();
}
/* a drag settled: items = [{i:originalIndex, startBar}] in the new left→right order.
   Reorder the lyric blocks to that order, then store each section's position (bars). */
function applyArrange(items){
  if(!items||!items.length)return;
  const {pre,blocks}=sectionBlocks();
  if(items.some(x=>x.i<0||x.i>=blocks.length))return;
  pushUndo();
  _writeDoc(pre, items.map(x=>blocks[x.i]));
  if(typeof manualBars!=="undefined")manualBars=items.map(x=>Math.round(x.startBar*1000)/1000); // positions, in new order (negative = before the anchor / bar 1)
  try{tagRegions();}catch{}
  if(typeof saveProjectState==="function")saveProjectState();   // persist the new region positions
  if(typeof tl!=="undefined"){tl.selRegions=[];tl.selRegion=-1;tl.sel=null;tl.render();}
}
/* rename section idx (timeline double-click) → rewrite its [Tag] header, preserving any
   "- N bars" length suffix already on the tag. */
function renameSection(idx,label){
  const {pre,blocks}=sectionBlocks();
  if(!blocks[idx])return;
  pushUndo();
  const inside=(blocks[idx].lines[0]||"").trim().replace(/^\[|\]$/g,"");
  const pb=(typeof parseTagBars==="function")?parseTagBars(inside):{bars:null};
  const np=(typeof parseTagBars==="function")?parseTagBars(String(label).replace(/^\[|\]$/g,"")):{name:String(label),bars:null};
  const name=(np.name||String(label)).replace(/^\[|\]$/g,"").trim()||inside;
  const bars=np.bars!=null?np.bars:pb.bars;                       // typed-in bars win, else keep existing
  blocks[idx].lines[0]= bars!=null ? `[${name} - ${bars} bars]` : `[${name}]`;
  _writeDoc(pre,blocks);
  try{tagRegions();}catch{}
  if(typeof saveProjectState==="function")saveProjectState();
}
/* set section idx's bar length (timeline bars dropdown). Writes "- N bars" into the tag,
   then anchors the FOLLOWING section to this one's new end and ripples the rest, so the
   next section always butts up against the edited section (even across 4→16→8 edits). */
function setRegionBars(idx,bars){
  bars=Math.max(1,Math.round(bars||1));
  pushUndo();
  const {pre,blocks}=sectionBlocks();
  if(!blocks[idx])return;
  const spb=(60/tl.bpm)*tl.beatsPerBar;
  const regs=tl.regions||[];
  const startsB=regs.map(r=>Math.round(r.start/spb));             // pre-edit start positions, in bars
  // rewrite header idx to carry the new bar count (keep the name + any other text)
  const inside=(blocks[idx].lines[0]||"").trim().replace(/^\[|\]$/g,"");
  const pb=(typeof parseTagBars==="function")?parseTagBars(inside):{name:inside};
  blocks[idx].lines[0]=`[${pb.name} - ${bars} bars]`;
  _writeDoc(pre,blocks);
  // materialise positions so the ripple is exact, then anchor the next section + shift the rest
  if(!manualBars||manualBars.length!==blocks.length)manualBars=startsB.slice();
  else manualBars=startsB.map((s,i)=>manualBars[i]!=null?manualBars[i]:s);
  if(idx+1<blocks.length){
    const shift=(startsB[idx]+bars)-startsB[idx+1];               // pull next to edited end
    for(let j=idx+1;j<blocks.length;j++)manualBars[j]=Math.max(0,manualBars[j]+shift);
  }
  manualBars[idx]=startsB[idx];                                   // edited section keeps its start (grows right)
  try{tagRegions();}catch{}
  if(typeof saveProjectState==="function")saveProjectState();
  if(typeof tl!=="undefined"){tl.selRegions=[idx];tl.selRegion=idx;tl.sel=tl.regions[idx]?{...tl.regions[idx]}:null;tl.render();}
}
/* delete the given section indices (and their lyric blocks). */
function deleteSections(idxs){
  const {pre,blocks}=sectionBlocks();
  const del=new Set(idxs);
  const hasContent=[...del].some(i=>blocks[i]&&_trimTrail(blocks[i].lines.slice(1)).length);
  // only the lyric-bearing delete needs a warning; empty regions delete silently (founder spec)
  if(hasContent&&!confirm(`Delete ${del.size>1?del.size+" sections":"this section"} and the lyrics inside? You can undo with Ctrl+Z.`))return;
  pushUndo();
  // KEEP the surviving sections exactly where they sit — materialise current positions and
  // drop only the deleted ones, so nothing snaps back to the start of the timeline.
  let mb=null;
  try{
    const spb=(60/tl.bpm)*tl.beatsPerBar;
    const cur=(tl.regions||[]).map(r=>Math.round(r.start/spb));
    let base=(typeof manualBars!=="undefined"&&manualBars&&manualBars.length===blocks.length)?manualBars.slice():cur;
    if(base.length!==blocks.length)base=cur;
    mb=base.filter((_,k)=>!del.has(k));
  }catch(e){mb=null;}
  _writeDoc(pre, blocks.filter((_,k)=>!del.has(k)));
  if(typeof manualBars!=="undefined")manualBars=(mb&&mb.length)?mb:null;
  try{tagRegions();}catch{}
  if(typeof tl!=="undefined"){tl.selRegions=[];tl.selRegion=-1;tl.sel=null;tl.render();}
  if(typeof saveProjectState==="function")saveProjectState();
  if(typeof toast==="function")toast("Section deleted — Ctrl+Z to undo");
}

/* ---- tag options menu: LEFT-CLICK a [Tag] in the word processor to open it. Holds the
   bar-length picker (4/8/16/32/Custom) plus Rename / Delete for that section. No dropdown
   lives on the timeline — this is the single place to set a section's length. ---- */
let _tagOptsEl=null;
function _tagOptsOff(e){if(_tagOptsEl&&!_tagOptsEl.contains(e.target))closeTagOpts();}
function closeTagOpts(){if(_tagOptsEl){_tagOptsEl.remove();_tagOptsEl=null;document.removeEventListener("mousedown",_tagOptsOff,true);}}
function openTagOpts(sectionIdx,x,y){
  closeTagOpts();
  let curBars=null,name="Section";
  try{const regs=(typeof tl!=="undefined"&&tl.regions)||[];if(regs[sectionIdx]){curBars=regs[sectionIdx].bars;name=regs[sectionIdx].label||name;}}catch(e){}
  const m=document.createElement("div");m.className="tagopts";
  m.innerHTML=`<div class="toh">${esc(name)}</div>`+
    `<div class="tol">Bar length</div>`+
    `<div class="tobars">`+[4,8,16,32].map(b=>`<span class="tob${b===curBars?' on':''}" data-b="${b}">${b}</span>`).join("")+
    `<span class="tob" data-b="custom">Custom…</span></div>`+
    `<div class="toopt" data-act="rename">&#9998; Rename…</div>`+
    `<div class="toopt danger" data-act="delete">&#128465; Delete section</div>`;
  document.body.appendChild(m);
  m.style.left=Math.min(window.innerWidth-186,Math.max(6,x))+"px";
  m.style.top=Math.min(window.innerHeight-196,y)+"px";
  m.querySelectorAll(".tob").forEach(el=>el.onmousedown=ev=>{ev.preventDefault();ev.stopPropagation();const v=el.dataset.b;closeTagOpts();
    if(v==="custom"){(window.askText?window.askText({title:"Custom bar length",sub:"How many bars should this section span?",value:String(curBars||4),placeholder:"e.g. 24",okLabel:"Set bars"}):Promise.resolve(prompt("Bars:",String(curBars||4)))).then(r=>{const n=parseInt(r,10);if(n>0)setRegionBars(sectionIdx,n);});}
    else setRegionBars(sectionIdx,+v);});
  m.querySelectorAll(".toopt").forEach(el=>el.onmousedown=async ev=>{ev.preventDefault();ev.stopPropagation();const act=el.dataset.act;closeTagOpts();
    if(act==="rename"){const nn=window.askText?await window.askText({title:"Rename section",value:name,placeholder:"Section name",okLabel:"Save"}):prompt("Rename section:",name);if(nn&&nn.trim())renameSection(sectionIdx,nn.trim());}
    else if(act==="delete")deleteSections([sectionIdx]);});
  _tagOptsEl=m;
  setTimeout(()=>document.addEventListener("mousedown",_tagOptsOff,true),0);
}
// left-click a tag span in the editor → open its options (rhyme-paint wraps tags in .sect)
doc.addEventListener("click",e=>{
  const sect=e.target.closest&&e.target.closest(".sect");if(!sect)return;
  const idx=[...doc.querySelectorAll(".sect")].indexOf(sect);if(idx<0)return;
  const r=sect.getBoundingClientRect();openTagOpts(idx,r.left,r.bottom+4);
});

/* ---- export the current document to a .txt file ---- */
$("lExport").onclick=()=>{
  const name=docsState.docs[docsState.active].name||"lyrics";
  const head=`# ${name}\n`+(cur?`# track: ${cur.name}  ·  ${detectedBpm||"?"} BPM${curKey?"  ·  "+curKey:""}\n`:"")+
             `# exported ${new Date().toLocaleString()}\n\n`;
  const blob=new Blob([head+doc.innerText.replace(/\r?\n/g,"\r\n")],{type:"text/plain"});
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);
  a.download=name.replace(/[^a-z0-9\-_ ]/gi,"_")+".txt";a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  toast("Exported "+a.download);
};

/* ---- stats ---- */
function renderStats(){
  const lines=doc.innerText.split("\n");const secs=[];let curSec=null;const endV=[];
  for(const l of lines){const t=l.trim();const m=t.match(/^\[(.+)\]$/);
    if(m){curSec={label:m[1],bars:0,words:0,syls:0};secs.push(curSec);continue;}
    if(!t)continue;if(!curSec){curSec={label:"—",bars:0,words:0,syls:0};secs.push(curSec);}
    const ws=t.split(/\s+/);curSec.bars++;curSec.words+=ws.length;curSec.syls+=sylOfBar(t);
    endV.push(vowelClass(rhymeAnchorWord(t)));}
  if(!secs.length){$("statsBox").innerHTML='<div class="muted">Empty document.</div>';return;}
  const tot=secs.reduce((a,s)=>({bars:a.bars+s.bars,words:a.words+s.words,syls:a.syls+s.syls}),{bars:0,words:0,syls:0});
  // metrics the methodology cares about: avg syllables/bar, longest scheme run, rhyme density
  let longest=0,run=0,last=null;for(const v of endV){if(v&&v===last)run++;else run=1;last=v;if(run>longest)longest=run;}
  const vc={};endV.forEach(v=>{if(v)vc[v]=(vc[v]||0)+1;});
  const paired=endV.filter(v=>v&&vc[v]>=2).length;
  const density=tot.bars?Math.round(100*paired/tot.bars):0;
  const avg=tot.bars?(tot.syls/tot.bars).toFixed(1):"0";
  $("statsBox").innerHTML=
    `<div class="statline">`+
      `<span class="statpill">bars <b>${tot.bars}</b></span>`+
      `<span class="statpill">avg syl/bar <b>${avg}</b></span>`+
      `<span class="statpill" title="longest unbroken run of one rhyme vowel">longest run <b>${longest}</b>${longest>=8?" ⚠":""}</span>`+
      `<span class="statpill" title="share of bars whose end-rhyme pairs with another bar">rhyme density <b>${density}%</b></span>`+
      `<span class="statpill">words <b>${tot.words}</b></span>`+
    `</div>`+
    `<details style="margin-top:6px"><summary class="muted" style="cursor:pointer;font-size:10.5px">per-section breakdown</summary>`+
    '<div class="statrow sthd"><span class="nm">section</span><span>bars</span><span>words</span><span>syl</span></div>'+
    secs.map(s=>`<div class="statrow"><span class="nm">[${esc(s.label)}]</span><span>${s.bars}</span><span>${s.words}</span><span>${s.syls}</span></div>`).join("")+
    `</details>`;
}
/* scheme map: one row per section, a colored dot per bar (anchor vowel + syllable
   count); a vowel run ≥8 bars is outlined red so you see where it's gone stale. */
function renderSchemeMap(){
  const el=$("schemeMap");if(!el)return;
  const lines=doc.innerText.split("\n");const secs=[];let cur=null;
  for(const l of lines){const t=l.trim();const m=t.match(/^\[(.+)\]$/);
    if(m){cur={label:m[1],bars:[]};secs.push(cur);}
    else if(t){if(!cur){cur={label:"—",bars:[]};secs.push(cur);}
      cur.bars.push({v:vowelClass(rhymeAnchorWord(t)),syl:sylOfBar(t)});}}
  const live=secs.filter(s=>s.bars.length);
  if(!live.length){el.innerHTML='<span class="muted">Write some bars to see the rhyme scheme.</span>';return;}
  el.innerHTML=live.map(s=>{
    const bars=s.bars;
    // mark bars in a cross-rhyme (ABAB): this end-vowel answers the bar TWO back, not the one
    // directly above (which differs) — i.e. v[i]==v[i-2] && v[i]!=v[i-1].
    const xr=bars.map((b,i)=>!!(b.v&&i>=2&&bars[i-2].v===b.v&&bars[i-1].v&&bars[i-1].v!==b.v));
    for(let i=0;i<bars.length;i++)if(xr[i]&&i>=2)xr[i-2]=true;   // light up the partner two bars up too
    let dots="",last=null,run=0;
    bars.forEach((b,i)=>{if(b.v&&b.v===last)run++;else run=1;last=b.v;
      const col=VC[b.v]||"#3a3d4d",stale=run>=8?" stale":"",cross=xr[i]?" xr":"";
      dots+=`<span class="smdot${stale}${cross}" style="background:${col}" title="${b.v||"—"}${b.v?" · "+vFriendly(b.v):""} · ${b.syl} syl${xr[i]?" · cross-rhyme (ABAB)":""}">${b.syl}</span>`;});
    const nm=(typeof parseTagBars==="function")?parseTagBars(s.label).name:s.label;
    return `<div class="smrow"><span class="smlab">${esc(nm)}</span>${dots}</div>`;
  }).join("");
}
/* syllable target = an OPTIONAL override gated by the Force-syllables toggle. Off (default) =
   match the prior bars; on = force this count (and flag overs in orange while writing). One
   control, no longer duplicated by the old "match syllables" dropdown. */
function sylForceOn(){const t=$("sylForceTog");return !!(t&&t.classList.contains("on"));}
function syncSylTarget(){
  const on=sylForceOn(),v=$("sylTarget").value;
  $("sylTarget").disabled=!on;
  if(on&&v)localStorage.setItem(TKEY,v);else localStorage.removeItem(TKEY);
  update();
}
(function initSylTarget(){
  const saved=localStorage.getItem(TKEY);
  if(saved){$("sylTarget").value=saved;$("sylForceTog").classList.add("on");$("sylTarget").disabled=false;}
  else{$("sylTarget").disabled=true;}
})();
$("sylForceTog").onclick=()=>{$("sylForceTog").classList.toggle("on");if(sylForceOn())setTimeout(()=>$("sylTarget").focus(),0);syncSylTarget();};
$("sylTarget").oninput=syncSylTarget;

/* bar-by-bar coaching (the This-Bar card + prediction chips) is OFF by default — it's the
   prescriptive "complete the couplet / land on this vowel" guidance some writers find noisy.
   The rhyme-word list and scheme map stay on. Toggle from the Write header. */
function applyBarGuide(){
  const on=localStorage.getItem("ams.barguide")==="1";
  if($("thisBar"))$("thisBar").style.display=on?"":"none";
  if($("rhyNext"))$("rhyNext").style.display=on?"":"none";
  const b=$("barGuideTog");if(b){b.textContent="Guidance: "+(on?"on":"off");b.classList.toggle("on",on);}
}
if($("barGuideTog"))$("barGuideTog").onclick=()=>{const on=localStorage.getItem("ams.barguide")==="1";localStorage.setItem("ams.barguide",on?"0":"1");applyBarGuide();};
applyBarGuide();

/* ---- generation-feel 2D pad ----
   feelX = rhythm density (0 packed/percussive → 100 sustained/spacious).
   feelY = context fidelity (0 on-theme/coherent → 100 rhythm-first/scaffold).
   Lower feelY lets the model trade meaning for a tighter meter; it also relaxes the
   paired-bar syllable check below. Both persist per browser. */
const FEELX="ams.lyrics.feelx", FEELY="ams.lyrics.feely";
let feelX=(()=>{let v=parseInt(localStorage.getItem(FEELX));if(!isNaN(v))return v;v=parseInt(localStorage.getItem("ams.lyrics.rhythm"));return isNaN(v)?30:v;})();
let feelY=(()=>{const v=parseInt(localStorage.getItem(FEELY));return isNaN(v)?30:v;})();
function feelXLabel(x){return x<=15?"Packed":x<=38?"Rhythmic":x<=62?"Balanced":x<=85?"Drawn-out":"Sparse";}
function feelYLabel(y){return y<=33?"on-theme":y<=66?"blended":"rhythm-first";}
function renderFeel(){const d=$("qdot");if(d){d.style.left=feelX+"%";d.style.top=feelY+"%";}if($("feelV"))$("feelV").textContent=feelXLabel(feelX)+" · "+feelYLabel(feelY);}
function setFeelFrom(e){const p=$("qpad");if(!p)return;const r=p.getBoundingClientRect();
  feelX=Math.round(Math.min(100,Math.max(0,((e.clientX-r.left)/r.width)*100)));
  feelY=Math.round(Math.min(100,Math.max(0,((e.clientY-r.top)/r.height)*100)));
  try{localStorage.setItem(FEELX,feelX);localStorage.setItem(FEELY,feelY);}catch(e){}renderFeel();}
if($("qpad")){let drag=false;const p=$("qpad");
  p.addEventListener("pointerdown",e=>{drag=true;try{p.setPointerCapture(e.pointerId);}catch(_){}setFeelFrom(e);});
  p.addEventListener("pointermove",e=>{if(drag)setFeelFrom(e);});
  p.addEventListener("pointerup",()=>drag=false);
  p.addEventListener("pointercancel",()=>drag=false);
  renderFeel();}

/* ---- Direction controls: theme / voice / mood / rhyme strength / internal rhyme / word lists / section ---- */
const DIR_KEYS=["dirTheme","dirPov","dirTense","dirMood","dirRhy","dirInt","dirInclude","dirAvoid","dirSection"];
function dirRhyLabel(v){return v<=25?"Perfect":v<=55?"Family":v<=80?"Slant":"Assonance";}
function dirIntLabel(v){return v<=20?"None":v<=50?"Some":v<=80?"Frequent":"Dense";}
function syncDir(){const r=$("dirRhy"),i=$("dirInt");if(r&&$("dirRhyV"))$("dirRhyV").textContent=dirRhyLabel(+r.value);if(i&&$("dirIntV"))$("dirIntV").textContent=dirIntLabel(+i.value);}
(function initDir(){
  DIR_KEYS.forEach(k=>{const el=$(k);if(!el)return;
    const saved=localStorage.getItem("ams.dir."+k);
    if(saved!=null){if(el.type==="checkbox")el.checked=saved==="1";else el.value=saved;}
    const ev=(el.tagName==="SELECT"||el.type==="checkbox")?"change":"input";
    el.addEventListener(ev,()=>{try{localStorage.setItem("ams.dir."+k,el.type==="checkbox"?(el.checked?"1":"0"):el.value);}catch(e){}syncDir();});
  });
  syncDir();
})();
/* the DIRECTION block injected into generation prompts (sec = current section name). All optional. */
function directionClauses(sec){
  const g=k=>{const el=$(k);return el?(el.type==="checkbox"?el.checked:String(el.value||"").trim()):"";};
  const out=[];
  const theme=g("dirTheme"); if(theme)out.push(`THEME — write about: ${theme}. Serve this subject while keeping every rhythm/rhyme rule.`);
  const pov=g("dirPov"),tense=g("dirTense");
  const povMap={first:"first person singular (I/me/my)",firstpl:"first person plural (we/us/our)",second:"second person (you/your)",third:"third person (they/he/she)"};
  if(pov||tense)out.push(`VOICE — ${[pov?povMap[pov]:"",tense?tense+" tense":""].filter(Boolean).join(", ")}; keep it consistent across the bars.`);
  const mood=g("dirMood"); if(mood)out.push(`MOOD — ${mood}: let word choice and imagery carry this tone.`);
  const rhy=+g("dirRhy")||0; out.push(`RHYME STRENGTH — ${rhy<=25?"PERFECT rhymes only (matching vowel AND ending consonants)":rhy<=55?"FAMILY rhymes: matching vowel, similar consonants — slant is fine":rhy<=80?"SLANT rhymes welcome: match the vowel, consonants are free":"ASSONANCE: vowel echoes suffice, consonants need not match"}.`);
  const intd=+g("dirInt")||0; if(intd>20)out.push(`INTERNAL RHYME — ${intd<=50?"add the occasional internal rhyme":intd<=80?"weave in frequent internal rhymes (several rhyming syllables per bar)":"pack dense internal rhymes throughout, rap-style"}, on top of the end-rhyme.`);
  const inc=g("dirInclude"); if(inc)out.push(`MUST INCLUDE — naturally work in: ${inc}.`);
  const avo=g("dirAvoid"); if(avo)out.push(`AVOID — never use: ${avo}.`);
  if(g("dirSection")){
    const s=(sec||"").toLowerCase(); let sp="";
    if(/pre.?chorus/.test(s))sp="PRE-CHORUS: build tension toward the chorus; you may tighten the rhythm.";
    else if(/chorus|hook/.test(s))sp="CHORUS: the memorable HOOK — more repetition, simpler/stickier phrasing, the emotional center; bars may share a length.";
    else if(/bridge/.test(s))sp="BRIDGE: contrast and lift — a new angle, fresh imagery, often the emotional turn.";
    else if(/intro|outro/.test(s))sp="INTRO/OUTRO: spare and atmospheric; set or release the mood.";
    else if(/verse/.test(s))sp="VERSE: narrative — advance the story with concrete detail; a little line-length variety is natural.";
    if(sp)out.push("SECTION — "+sp);
  }
  // soft cadence/stress mirror (true programmatic stress-lock needs a pronunciation dict — roadmap item)
  out.push("CADENCE — by ear, mirror the stressed-syllable pattern (the strong beats) of the prior bars, not just the syllable count.");
  return out.length?`\n\nDIRECTION (high priority for meaning; the numbered rhythm/rhyme rules still bind):\n- ${out.join("\n- ")}`:"";
}

/* ---- vowel classes + rhyme banks ---- */
const VOPTS=["AY","EY","OW","IY","UW","OY","AW","AE","EH","IH","AH","UH","AO","AR","OR","ER"];
const VC={AY:"#7c5cff",EY:"#19d3c5",OW:"#ff8a4c",IY:"#5b6cff",UW:"#48b06a",OY:"#ff8a4c",AW:"#48b06a",
  AE:"#c45cff",EH:"#d9a23b",IH:"#5b8cff",AH:"#9aa0b4",UH:"#48b06a",AO:"#ff8a4c",AR:"#ff5c8c",OR:"#ff7a5c",ER:"#b06a9a"};
const NEAR={
  AY:["light","sky","high","tonight","bright","mind","time","line","ride","alive"],
  EY:["game","name","same","flame","stay","away","rain","day","chain","frame"],
  OW:["go","slow","below","road","soul","hold","alone","know","glow","told"],
  IY:["free","see","dream","keep","believe","beneath","reason","evening"],
  UW:["true","through","move","room","soon","bloom","you","prove"],
  OY:["boy","joy","toy","destroy","employ","enjoy","avoid","noise"],
  AW:["now","how","down","crown","sound","around","found","ground"],
  AE:["back","black","chance","dance","stand","hand","lamp","glance"],
  EH:["edge","said","again","head","red","thread","breath","depth"],
  IH:["this","wind","spin","within","begin","sing","king","still"],
  AH:["love","above","enough","touch","rush","trust","jump","blood"],
  UH:["good","stood","would","could","book","look","took","put"],
  AO:["all","call","fall","small","tall","dawn","gone","caught"],
  AR:["dark","spark","heart","part","start","mark","apart","hard"],
  OR:["more","store","door","before","war","four","pour","explore"],
  ER:["world","word","heard","bird","burn","turn","learn","return"]
};
const SLANT={
  AY:["decide","horizon","silent","define","arrive"],EY:["escape","remain","betray","cascade"],
  OW:["shadow","tomorrow","follow","willow"],IY:["easy","secret","meeting"],UW:["rescue","value"],
  AE:["after","answer"],EH:["empty","envy"],IH:["minute","limit","spirit"],AH:["under","other","wonder"],
  AO:["water","auto","fallen"],AR:["ardent","garden","target"],OR:["order","forty","corner"],ER:["service","certain","perfect"]
};
const VEXC={
  the:"AH",a:"AH",to:"UW",into:"UW",do:"UW",who:"UW",you:"UW",i:"AY",my:"AY",by:"AY",why:"AY",
  he:"IY",she:"IY",we:"IY",me:"IY",be:"IY",of:"AH",love:"AH",above:"AH",glove:"AH",one:"AH",done:"AH",
  gone:"AO",come:"AH",become:"AH",some:"AH",none:"AH",son:"AH",won:"AH",ton:"AH",front:"AH",month:"AH",
  young:"AH",tongue:"AH",was:"AH",does:"AH",most:"OW",host:"OW",ghost:"OW",post:"OW",both:"OW",go:"OW",
  so:"OW",no:"OW",pro:"OW",like:"AY",time:"AY",mind:"AY",find:"AY",kind:"AY",night:"AY",light:"AY",
  right:"AY",high:"AY",eye:"AY",buy:"AY",die:"AY",toast:"OW",coast:"OW",said:"EH",again:"EH",dead:"EH",
  head:"EH",bread:"EH",dread:"EH",death:"EH",breath:"EH",friend:"EH",are:"AR",car:"AR",far:"AR",star:"AR",
  heart:"AR",guard:"AR",hard:"AR",dark:"AR",more:"OR",door:"OR",floor:"OR",for:"OR",four:"OR",your:"OR",
  pour:"OR",war:"OR",roar:"OR",sure:"OR",word:"ER",world:"ER",work:"ER",worth:"ER",first:"ER",girl:"ER",
  bird:"ER",heard:"ER",earth:"ER",learn:"ER",her:"ER",were:"ER",boy:"OY",joy:"OY",toy:"OY",now:"AW",
  how:"AW",down:"AW",town:"AW",out:"AW",about:"AW",good:"UH",would:"UH",could:"UH",should:"UH",put:"UH",
  push:"UH","full":"UH",day:"EY",they:"EY",way:"EY",say:"EY",hey:"EY",grey:"EY","great":"EY","break":"EY",
  "steak":"EY",what:"AH",want:"AO",water:"AO",this:"IH",is:"IH",it:"IH","in":"IH","with":"IH",his:"IH",
  "if":"IH",been:"IH",too:"UW",two:"UW",true:"UW",blue:"UW",new:"UW",through:"UW",touch:"AH",rough:"AH",
  tough:"AH",enough:"AH",cousin:"AH",cow:"AW",brown:"AW",crown:"AW",frown:"AW",clown:"AW",owl:"AW",
  foot:"UH",wood:"UH",hook:"UH",cook:"UH",shook:"UH",wool:"UH"
};
function vowelClass(word){
  word=(word||"").toLowerCase().replace(/[^a-z]/g,"");
  if(!word)return null;
  if(VEXC[word])return VEXC[word];
  if(typeof VDICT!=="undefined"&&VDICT[word])return VDICT[word];
  if(/[^aeiou]y$/.test(word))return syllables(word)>1?"IY":"AY";
  let w=word,magic=false;
  if(/[aeiou][bcdfghjklmnpqrstvwxz]e$/.test(w)){magic=!/[aeiou][aeiou][bcdfghjklmnpqrstvwxz]e$/.test(w);w=w.slice(0,-1);}
  const groups=[...w.matchAll(/[aeiouy]+/g)];if(!groups.length)return null;
  const g=groups[groups.length-1];let v=g[0],coda=w.slice(g.index+v.length);
  const fold=coda.match(/^[wy]/);if(fold){v+=fold[0];coda=coda.slice(1);}
  const DI={igh:"AY",eigh:"EY",ai:"EY",ay:"EY",ei:"EY",ey:"EY",ee:"IY",ea:"IY",ie:"IY",
    oa:"OW",ow:"OW",oe:"OW",oo:"UW",ou:"AW",ue:"UW",ew:"UW",ui:"UW",oi:"OY",oy:"OY",au:"AO",aw:"AO"};
  for(const len of [4,3,2]){const t=v.slice(-len);if(DI[t]){
    if(t==="ow"&&/^[nl]/.test(coda))return "AW";
    if(t==="oo"&&/^k/.test(coda))return "UH";
    if(t==="ea"&&/^(d|th)/.test(coda))return "EH";
    if(t==="ou"&&/^(gh|nd|nt|gr)/.test(coda)&&!/ought/.test(w))return "AW";
    return DI[t];}}
  const last=v[v.length-1];
  if(/^r/.test(coda)||coda===""&&/r$/.test(v))return {a:"AR",o:"OR",e:"ER",i:"ER",u:"ER"}[last]||null;
  if(magic)return {a:"EY",i:"AY",o:"OW",u:"UW",e:"IY",y:"AY"}[last]||null;
  if(coda==="")return {a:"AH",e:"IY",i:"AY",o:"OW",u:"UW",y:"IY"}[last]||null;
  if(last==="a"&&/^l/.test(coda))return "AO";
  if(last==="o"&&/^(ld|ll|st|th)/.test(coda))return "OW";
  return {a:"AE",e:"EH",i:"IH",o:"AH",u:"AH",y:"IH"}[last]||null;
}

/* ---- caret tracking ---- */
let selLine=-1,selTick=null,heldCls=null,heldWord=null;
document.addEventListener("selectionchange",()=>{
  if(selTick)return;
  selTick=setTimeout(()=>{selTick=null;
    const s=document.getSelection();
    if(!s||!s.rangeCount||!doc.contains(s.anchorNode))return;
    const r=s.getRangeAt(0).cloneRange();r.collapse(true);
    const pre=document.createRange();pre.selectNodeContents(doc);
    try{pre.setEnd(r.startContainer,r.startOffset);}catch{return;}
    selLine=pre.toString().split("\n").length-1;refreshLinePanels();
    try{lastCaret=caretOffset();}catch{}
    try{updateFlowHud();}catch{}
    try{showTagMenu();}catch{}
  },120);
});

doc.addEventListener("blur",()=>{const h=$("flowHud");if(h)h.style.display="none";});
/* ---- position-aware prediction ---- */
function barPositions(line){
  const ws=line.trim().split(/\s+/).filter(Boolean);let cum=0;const pos=[];
  for(const w of ws){cum+=syllables(w);const vc=vowelClass(w);if(vc)pos.push({syl:cum,vowel:vc,word:w});}
  return pos;
}
/* the rhyme ANCHORS of a line, by syllable position: the end vowel, plus any earlier
   word carrying the SAME vowel (an internal rhyme of the same family). */
function lineAnchors(line){
  const pos=barPositions(line);if(!pos.length)return [];
  const end=pos[pos.length-1];
  const anchors=[{syl:end.syl,vowel:end.vowel}];
  for(const p of pos.slice(0,-1)){
    const cl=p.word.toLowerCase().replace(/[^a-z]/g,"");
    if(p.vowel===end.vowel&&!STOP.has(cl))anchors.push({syl:p.syl,vowel:p.vowel});
  }
  return anchors.sort((a,b)=>a.syl-b.syl);
}
/* Rhyme countdown HUD — follows the caret while typing a bar and shows how many
   syllables remain until the next rhyme target (taken from the bar above), and which
   vowel to land on. Counts down as syllables are typed; hides once reached. */
function updateFlowHud(){
  const hud=$("flowHud");if(!hud)return;
  const s=document.getSelection();
  if(!s||!s.rangeCount||!s.isCollapsed||!doc.contains(s.anchorNode)){hud.style.display="none";return;}
  const r=s.getRangeAt(0).cloneRange();r.collapse(true);
  const pre=document.createRange();pre.selectNodeContents(doc);
  try{pre.setEnd(r.startContainer,r.startOffset);}catch{hud.style.display="none";return;}
  const flat=pre.toString();
  const lines=doc.innerText.split("\n");
  const lineIdx=flat.split("\n").length-1;
  const curLine=lines[lineIdx]||"";
  if(isTag(curLine.trim())){hud.style.display="none";return;}
  let prev=null;for(let i=lineIdx-1;i>=0;i--){const t=lines[i].trim();if(t&&!isTag(t)){prev=lines[i];break;}}
  if(!prev){hud.style.display="none";return;}
  const anchors=lineAnchors(prev);if(!anchors.length){hud.style.display="none";return;}
  const prefix=flat.slice(flat.lastIndexOf("\n")+1);
  const soFar=prefix.trim().split(/\s+/).filter(Boolean).reduce((n,w)=>n+syllables(w),0);
  const next=anchors.find(a=>a.syl>soFar);
  if(!next){hud.style.display="none";return;}                 // reached/passed the last rhyme
  const left=next.syl-soFar;
  const rect=r.getBoundingClientRect();
  let x=rect.left,y=rect.top;
  if(!x&&!y){const cr=(r.startContainer.nodeType===1?r.startContainer:r.startContainer.parentNode).getBoundingClientRect();x=cr.left;y=cr.top;}
  hud.innerHTML=`<b>${left}</b> &rarr; <span class="vw" style="background:${VC[next.vowel]||'#7c5cff'}">${next.vowel}</span>`;
  hud.style.display="";
  hud.style.left=Math.min(window.innerWidth-90,Math.max(6,x+14))+"px";
  hud.style.top=Math.max(6,y-30)+"px";
}
function caretPrefix(){
  const s=document.getSelection();if(!s||!s.rangeCount||!doc.contains(s.anchorNode))return null;
  const r=s.getRangeAt(0).cloneRange();r.collapse(true);
  const pre=document.createRange();pre.selectNodeContents(doc);
  try{pre.setEnd(r.startContainer,r.startOffset);}catch{return null;}
  const t=pre.toString();return t.slice(t.lastIndexOf("\n")+1);
}
function predictNextVowel(prevLine,sylSoFar){
  const pos=barPositions(prevLine);if(!pos.length)return null;
  const nxt=pos.find(p=>p.syl>sylSoFar+0.001)||pos[pos.length-1];
  return {vowel:nxt.vowel,at:nxt.syl,word:nxt.word,end:nxt===pos[pos.length-1]};
}
function copyChip(w){if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(w).then(()=>toast(`"${w}" copied`)).catch(()=>toast(w));else toast(w);}
/* friendly vowel labels so non-phonetics users don't have to guess the ARPABET codes */
const VLABEL={AY:'"eye"',EY:'"ay"',OW:'"oh"',IY:'"ee"',UW:'"oo"',OY:'"oy"',AW:'"ow"',AE:'"a"',EH:'"eh"',IH:'"ih"',AH:'"uh"',UH:'"uu"',AO:'"aw"',AR:'"ar"',OR:'"or"',ER:'"er"'};
function vTone(v){const b=BRIGHT[v];return b>=.55?"bright":b<=.3?"dark":"mid";}
function vFriendly(v){return v&&VLABEL[v]?`${VLABEL[v]} · ${vTone(v)}`:"";}
/* one action vocabulary for every suggestion chip: click = insert at the caret,
   Shift+click = copy. (mousedown is suppressed so the doc keeps its caret.) */
let lastCaret=null;
function insertAtCaret(w){
  doc.focus();
  const text=doc.innerText;
  let off=caretOffset();if(off==null)off=(lastCaret!=null?lastCaret:text.length);
  const before=text.slice(0,off),after=text.slice(off);
  let ins=w;
  if(before&&!/\s$/.test(before))ins=" "+ins;
  if(after.length&&!/^\s/.test(after))ins=ins+" ";
  doc.textContent=before+ins+after;
  if(rhymeOn)paintRhymes();else update();
  setCaret((before+ins).length);
}
function chipEvents(el){
  el.querySelectorAll("[data-w]").forEach(c=>{
    c.onmousedown=e=>e.preventDefault();
    c.onclick=e=>{const w=c.dataset.w;if(e.shiftKey)copyChip(w);else fillBarWithWord(w);};
  });
}
/* GUIDANCE chips: land the rhyme at the END of the current bar, generating context-aware
   syllables BEFORE it so it sits in the right rhythmic spot. Uses the chosen AI engine when a
   key is set; otherwise just drops the word at the end of the bar. Shift+click = copy. */
async function fillBarEndingOn(word){
  doc.focus();
  const text=doc.innerText;let off=caretOffset();if(off==null)off=(lastCaret!=null?lastCaret:text.length);
  let ls=text.lastIndexOf("\n",off-1)+1;let le=text.indexOf("\n",off);if(le<0)le=text.length;
  const line=text.slice(ls,le).trim();
  const provider=($("aiProvider")&&$("aiProvider").value)||localStorage.getItem("ams.ai.provider")||"free";
  const haveKey=provider!=="free"&&typeof aiKeyOf==="function"&&aiKeyOf(provider);
  let newLine=null;
  if(haveKey&&typeof callLLM==="function"){
    const note=$("ideaNote");if(note){note.className="muted";note.style.color="";note.textContent="Phrasing…";}
    const ctx=(typeof priorContext==="function")?priorContext():{sec:"Verse",prior:[]};
    const tgt=(typeof sylForceOn==="function"&&sylForceOn()&&+($("sylTarget").value||0))||null;
    const sys=`You are a lyricist. Write ONE short lyric line (a single bar) for the [${ctx.sec}] section that ENDS on the exact word "${word}". ${line?`Build it from this partial line, keeping its words: "${line}".`:""} ${tgt?`Aim for ~${tgt} syllables.`:"Match the syllable count and cadence of the prior bars."} It must flow naturally and fit the vibe; rhythm and the end-rhyme matter most. Output ONLY the line — no quotes, no notes.`;
    const usr=(ctx.prior.length?`Prior bars:\n${ctx.prior.join("\n")}\n\n`:"")+`Write the line, ending on "${word}".`;
    try{const out=await callLLM({provider,model:(($("aiModel")&&$("aiModel").value.trim())||aiModelOf(provider)),system:sys,user:usr,maxTokens:800});newLine=(out||"").split("\n").map(s=>s.trim()).filter(Boolean)[0]||null;}catch(e){newLine=null;}
    if(note)note.textContent="";
  }
  if(!newLine)newLine=line?(line.replace(/[,;:]\s*$/,"")+" "+word):word;   // fallback: word at end of bar
  pushUndo();
  doc.textContent=text.slice(0,ls)+newLine+text.slice(le);
  if(rhymeOn)paintRhymes();else update();
  setCaret(ls+newLine.length);
}
function chipEventsGen(el){
  el.querySelectorAll("[data-w]").forEach(c=>{
    c.onmousedown=e=>e.preventDefault();
    c.onclick=e=>{const w=c.dataset.w;if(e.shiftKey)copyChip(w);else fillBarEndingOn(w);};
  });
}
/* RHYME-WORD click (the "Rhyme words for…" list): write a WHOLE new bar that ENDS on the word with the
   ideal number of lead-in syllables (matched to the bar above), then INSERT it — the cursor's bar and
   everything below it push down. EXCEPTION: highlight exactly one whole bar and it REPLACES that bar.
   A partial highlight never replaces. Shift+click still copies. (chips suppress mousedown → caret/selection kept.) */
async function fillBarWithWord(word){
  doc.focus();
  const text=doc.innerText;
  let mode="insert",ls,le;
  const o=(typeof selOffsets==="function")?selOffsets():null;
  if(o){                                                              // whole first bar highlighted → replace it
    const fls=text.lastIndexOf("\n",o.start-1)+1; let fle=text.indexOf("\n",fls); if(fle<0)fle=text.length;
    const lt=text.slice(fls,fle).trim();
    if(o.start<=fls&&o.end>=fle&&lt&&!isTag(lt)){mode="replace";ls=fls;le=fle;}
  }
  if(mode==="insert"){
    let off=caretOffset(); if(off==null)off=(lastCaret!=null?lastCaret:text.length);
    ls=text.lastIndexOf("\n",off-1)+1; le=text.indexOf("\n",ls); if(le<0)le=text.length;
    const lt=text.slice(ls,le);
    if(lt.trim()&&!isTag(lt.trim())&&off>=le)mode="complete";        // caret at END of a bar you're writing → finish IT (keep typed syllables)
  }
  const partial=(mode==="complete")?text.slice(ls,le).replace(/\s+$/,""):"";
  // ideal syllable target = the nearest lyric bar ABOVE the spot (the rhythm to echo)
  const lines=text.split("\n"), curIdx=text.slice(0,ls).split("\n").length-1;
  let tgt=null; for(let i=curIdx-1;i>=0;i--){const t=lines[i].trim();if(t&&!isTag(t)){tgt=sylOfBar(t);break;}}
  if(!tgt)tgt=(typeof sylForceOn==="function"&&sylForceOn()&&+($("sylTarget").value||0))||6;
  const provider=($("aiProvider")&&$("aiProvider").value)||localStorage.getItem(AI_PROV_LS)||"groq";
  const haveKey=provider!=="free"&&typeof aiKeyOf==="function"&&aiKeyOf(provider);
  let newLine=null;
  if(haveKey&&typeof callLLM==="function"){
    const note=$("ideaNote"); if(note){note.className="muted";note.style.color="";note.textContent="Phrasing…";}
    const ctx=(typeof priorContext==="function")?priorContext():{sec:"Verse",prior:[]};
    let sys,usr;
    if(mode==="complete"){                                            // keep what's typed; fill the rest to the target, ending on the word
      sys=`You are a lyricist. COMPLETE this partial lyric bar for [${ctx.sec}]: KEEP its existing words exactly at the start, then add context syllables so the WHOLE bar is about ${tgt} syllables and ENDS on the exact word "${word}". Concrete, specific imagery; avoid clichés (${CLICHE}). Output ONLY the completed line — no quotes or notes.`;
      usr=`Partial bar so far (${sylOfBar(partial)} syllables): "${partial}". Complete it to ~${tgt} syllables, ending on "${word}".`;
    }else{
      sys=`You are a lyricist. Write ONE lyric bar for [${ctx.sec}] that ENDS on the exact word "${word}" and has about ${tgt} syllables, matching the cadence of the prior bars. Concrete, specific imagery; avoid clichés (${CLICHE}). Output ONLY the line — no quotes or notes.`;
      usr=(ctx.prior.length?`Prior bars:\n${ctx.prior.join("\n")}\n\n`:"")+`Write the bar (~${tgt} syllables), ending on "${word}".`;
    }
    try{const out=await callLLM({provider,model:(($("aiModel")&&$("aiModel").value.trim())||aiModelOf(provider)),system:sys,user:usr,maxTokens:800});newLine=(out||"").split("\n").map(s=>s.trim()).filter(Boolean)[0]||null;}catch(e){newLine=null;}
    if(note)note.textContent="";
  }
  if(!newLine)newLine=(mode==="complete"&&partial)?(partial+" "+word):word;   // no key → keep the partial + word, else just the word
  pushUndo();
  const t2=doc.innerText;
  if(mode==="replace"||mode==="complete")doc.textContent=t2.slice(0,ls)+newLine+t2.slice(le);   // swap the line in place
  else{const cur=t2.slice(ls,le).trim();doc.textContent=cur?(t2.slice(0,ls)+newLine+"\n"+t2.slice(ls)):(t2.slice(0,ls)+newLine+t2.slice(le));}
  if(rhymeOn)paintRhymes();else update();
  setCaret(ls+newLine.length);
  try{tagRegions();}catch(e){}
}
/* vowel "brightness" (high-front = bright → low-back = dark). Used to pick CONTRAST
   when opening a new scheme: a fresh anchor far in brightness from the one you just
   closed reads as a clear new section to the ear. */
const BRIGHT={IY:1,IH:.9,EY:.8,EH:.7,AE:.6,AY:.66,OY:.52,AH:.5,ER:.46,AW:.42,UH:.36,UW:.3,OW:.26,AO:.2,OR:.18,AR:.14};
function freshVowels(lastVowel,used){
  const lb=BRIGHT[lastVowel]!=null?BRIGHT[lastVowel]:.5;
  return Object.keys(BRIGHT)
    .filter(v=>!used.has(v)&&NEAR[v]&&NEAR[v].length)
    .map(v=>({v,d:Math.abs(BRIGHT[v]-lb)}))
    .sort((a,b)=>b.d-a.d).slice(0,3).map(x=>x.v);
}
/* how many consecutive content bars ENDING at (and including) the bar above `idx`
   share the same end-vowel — i.e. how long the current scheme has run. */
function schemeRun(lines,idx){
  const vow=[];for(let i=0;i<idx;i++){const t=lines[i].trim();if(t&&!isTag(t)){const v=vowelClass(rhymeAnchorWord(t));vow.push(v);}}
  if(!vow.length)return {vowel:null,run:0};
  const last=vow[vow.length-1];let run=0;
  for(let i=vow.length-1;i>=0;i--){if(vow[i]===last)run++;else break;}
  return {vowel:last,run};
}
/* Bar-above guidance. Two answer shapes are recognised:
   • COUPLET (AABB) — the bar directly above; even bars usually close it.
   • CROSS / ALTERNATING rhyme (ABAB) — answering the bar TWO above, so a pair lands every
     other bar. Once an ...A B A run appears, the next bar is expected to be B; even a loose
     (slant / "family") pair reads as intentional because the pattern repeats. Theory: this
     is the classic alternating/cross rhyme scheme; weak pairs that recur are "family rhymes"
     (Pattison). A scheme running ≥8 bars on one vowel is flagged to switch. */
function renderPrediction(idx,lines){
  const head=$("rhyNextHead"),pill=$("rhyNextPill"),why=$("rhyNextWhy"),chips=$("rhyNext");
  let prev=-1;for(let i=idx-1;i>=0;i--){const t=lines[i].trim();if(t&&!isTag(t)){prev=i;break;}}
  let bar=0;for(let i=0;i<idx;i++){const t=lines[i].trim();if(t&&!isTag(t))bar++;}
  const curBar=bar+1;                                  // the bar being worked on (1-indexed, continuous)
  head.style.display="";
  const vlab=$("tbVlab");
  const setChips=(v,filterSelf)=>{
    if(vlab)vlab.textContent=vFriendly(v);
    const self=filterSelf?(heldWord||"").toLowerCase().replace(/[^a-z]/g,""):"";
    chips.innerHTML=((NEAR[v]||[]).filter(w=>w!==self).slice(0,8).map(w=>`<span class="chip" data-w="${w}" title="click: complete the bar ending on this word (uses your AI engine) · Shift+click: copy">${w}</span>`).join(""))||'<span class="muted">—</span>';
    chipEventsGen(chips);                               // guidance chips → land the rhyme at the END of the bar
  };
  if(prev<0){                                          // very first bar — it sets the scheme
    pill.textContent="SET";pill.style.background="var(--ok)";if(vlab)vlab.textContent="";
    why.innerHTML=`Bar 1 — <b>set the first anchor</b>. The vowel you end on becomes the scheme to answer on bar 2.`;
    chips.innerHTML="";return;
  }
  const prevWord=rhymeAnchorWord(lines[prev]);
  const prevVowel=vowelClass(prevWord);
  const prevSyl=lines[prev].trim().split(/\s+/).reduce((n,w)=>n+syllables(w),0);
  const {vowel:runVowel,run}=schemeRun(lines,idx);
  // recent end-vowels (and the bar two above) for cross-rhyme detection
  const ev=[],ew=[];for(let i=0;i<idx;i++){const t=lines[i].trim();if(t&&!isTag(t)){const w=rhymeAnchorWord(t);ev.push(vowelClass(w));ew.push(w);}}
  const n=ev.length,v1=ev[n-1]||null,v2=ev[n-2]||null,v3=ev[n-3]||null;
  const prev2Word=ew[n-2]||null,prev2Vowel=v2;
  const altEstablished=v1&&v2&&v3&&v3===v1&&v1!==v2;   // ...A B A → next bar is expected to be B
  const warn=run>=8?` &middot; <b style="color:var(--danger)">${run} bars on ${runVowel} — switch it up</b>`:"";
  const showV=v=>{pill.textContent=v||"?";pill.style.background=VC[v]||"#7c5cff";setChips(v,v===prevVowel);
    why.querySelectorAll("[data-ov]").forEach(s=>s.classList.toggle("vsel",s.dataset.ov===v));};
  const clean=w=>(w||"").replace(/[^a-zA-Z']/g,"");
  const ovPill=v=>`<span class="vw" data-ov="${v}" style="background:${VC[v]};cursor:pointer">${v}</span>`;
  if(altEstablished){                                  // CROSS-RHYME (ABAB) is rolling → answer two bars back
    why.innerHTML=`Bar ${curBar} <b>continues the cross-rhyme</b> <span class="tbbadge even" style="background:var(--accent)">ABAB</span> — answer bar ${curBar-2} on ${ovPill(prev2Vowel)} like "${clean(prev2Word)}". The pair lands every other bar, so even a loose match reads as intentional.${warn}`;
    showV(prev2Vowel);
    why.querySelectorAll("[data-ov]").forEach(s=>s.onclick=()=>showV(s.dataset.ov));
  }else if(curBar%2===0){                              // EVEN — complete the couplet (+ cross-rhyme alt)
    const alt=(prev2Vowel&&prev2Vowel!==prevVowel)?` &middot; or <b>cross-rhyme</b> bar ${curBar-2} on ${ovPill(prev2Vowel)} <span class="muted">(ABAB)</span>`:"";
    why.innerHTML=`Bar ${curBar} <b>completes the couplet</b> — land on ${ovPill(prevVowel||"AH")} like "${clean(prevWord)}", ~<b>${prevSyl}</b> syl.${alt}${warn}`;
    showV(prevVowel);
    why.querySelectorAll("[data-ov]").forEach(s=>s.onclick=()=>showV(s.dataset.ov));
  }else{                                               // ODD — can open a new scheme
    const used=new Set();let seen=0;
    for(let i=prev;i>=0&&seen<2;i--){const t=lines[i].trim();if(!t||isTag(t))continue;seen++;const v=vowelClass(rhymeAnchorWord(t));if(v)used.add(v);}
    const fresh=freshVowels(prevVowel,used);
    const ovo=v=>`<span class="vw" data-ov="${v}" style="background:${VC[v]};cursor:pointer">${v}</span>`;
    const showV=v=>{pill.textContent=v;pill.style.background=VC[v]||"#7c5cff";setChips(v,false);
      why.querySelectorAll("[data-ov]").forEach(s=>s.classList.toggle("vsel",s.dataset.ov===v));};
    // the "last scheme" = the bar you just finished (prevVowel) — offer to stay on it
    const keepOpt=prevVowel?` &middot; or stay on the last scheme — ${ovo(prevVowel)} like "${clean(prevWord)}"`:"";
    why.innerHTML=`Bar ${curBar} <b>can open a new scheme</b> — fresh, contrasting anchors: `+
      fresh.map(v=>ovo(v)).join(" ")+keepOpt+
      `<br><span class="muted">Tip: a vowel different from this bar sets up a <b>cross-rhyme</b> (ABAB) — answer it two bars down.</span>`;
    showV(fresh[0]||prevVowel||"AH");
    why.querySelectorAll("[data-ov]").forEach(s=>s.onclick=()=>showV(s.dataset.ov));
  }
}
function refreshLinePanels(){
  const lines=doc.innerText.split("\n");
  const isContent=i=>{const t=lines[i].trim();return !!t&&!isTag(t);};
  // an EMPTY line is NOT a bar. If the caret sits on one, guide the NEXT bar (the one it WOULD
  // become) using the bar ABOVE it in this section — never fall through to the doc's last bar.
  let pending=false, idx=-1;
  if(selLine>=0&&selLine<lines.length){
    if(isContent(selLine))idx=selLine;
    else for(let i=selLine;i>=0;i--){const t=lines[i].trim();if(/^\[.+\]$/.test(t))break;if(isContent(i)){idx=i;pending=true;break;}}
  }else for(let i=lines.length-1;i>=0;i--)if(isContent(i)){idx=i;break;}   // no caret tracked → default to last bar
  if(idx<0){heldCls=null;heldWord=null;
    $("tbSection").textContent="—";$("tbBar").textContent="—";$("tbBadge").className="tbbadge";$("tbBadge").textContent="";$("tbSyl").textContent="";
    $("rhyWord").textContent="—";$("rhyPill").style.display="none";
    $("rhymeList").innerHTML='<span class="muted">—</span>';
    if($("ideaCtx"))$("ideaCtx").textContent=(selLine>=0)?"Not on a bar — type here to add the next bar.":"Document is empty — write a line, then click it.";renderForce([]);
    $("rhyNextHead").style.display="none";$("rhyNext").innerHTML="";return;}
  let secLab="—";for(let i=idx;i>=0;i--){const m=lines[i].trim().match(/^\[(.+)\]$/);if(m){secLab=m[1];break;}}
  let bar=0;for(let i=0;i<=idx;i++)if(isContent(i))bar++;
  if(pending)bar++;                                              // the empty line is the NEXT bar in sequence
  const ws=lines[idx].trim().split(/\s+/);const syl=sylOfBar(lines[idx]);const endW=rhymeAnchorWord(lines[idx]);
  // This-Bar card: section · bar № · even/odd badge · live syllables (vs target)
  const even=bar%2===0,tgt=(typeof sylForceOn==="function"&&sylForceOn())?+($("sylTarget").value||0):0;
  $("tbSection").textContent="["+secLab+"]";$("tbBar").innerHTML=pending?(bar+' <span style="opacity:.55">· next</span>'):String(bar);
  const badge=$("tbBadge");badge.className="tbbadge "+(even?"even":"odd");badge.textContent=even?"complete couplet":"open scheme";
  $("tbSyl").innerHTML=pending?`&middot; <i>empty line</i> &middot; target <b>~${syl}</b> syl`:(tgt?`&middot; <b style="color:${syl>tgt?'var(--warn)':'var(--txt)'}">${syl}</b>/${tgt} syl`:`&middot; <b>${syl}</b> syl`);
  const {fams,cnt}=rhymeFams(lines);const classes=[];
  const addCls=w=>{const c=vowelClass(w);if(c&&!classes.includes(c)&&classes.length<3)classes.push(c);};
  addCls(endW);
  for(const w of ws.slice(0,-1)){const k=endVowelKey(w),cl=w.toLowerCase().replace(/[^a-z]/g,"");
    if(k&&(k in fams)&&cnt[k]>=2&&cl.length>=3&&!STOP.has(cl))addCls(w);}
  const liveCls=vowelClass(endW);
  if(liveCls){heldCls=liveCls;heldWord=endW;}
  const cls=liveCls||heldCls;const word=liveCls?endW:(heldWord||endW);
  const self=(word||"").toLowerCase().replace(/[^a-z]/g,"");
  $("rhyWord").textContent=(word||"").replace(/[^a-zA-Z']/g,"")||"—";
  const pill=$("rhyPill");
  if(cls){pill.style.display="";pill.textContent=cls;pill.style.background=VC[cls];pill.title=vFriendly(cls);}else pill.style.display="none";
  // unified, strength-tagged, vowel-colored rhyme word list (rhyme = vowel match, slant = assonance)
  const col=(VC[cls]||"#7c8")+"77";
  const mk=(w,kind)=>`<span class="chip rchip" data-w="${esc(w)}" style="border-color:${col}" title="click: write a new bar ending on &quot;${esc(w)}&quot; (ideal syllables) and insert it · highlight a whole bar first to replace that bar · Shift+click: copy">${esc(w)}<span class="tg">${kind}</span></span>`;
  const near=((cls&&NEAR[cls])||[]).filter(w=>w!==self);
  const slant=((cls&&SLANT[cls])||[]).filter(w=>w!==self);
  $("rhymeList").innerHTML=(near.map(w=>mk(w,"rhyme")).join("")+slant.map(w=>mk(w,"slant")).join(""))||'<span class="muted">—</span>';
  chipEvents($("rhymeList"));
  if($("ideaCtx"))$("ideaCtx").innerHTML=`From caret: <b>[${esc(secLab)}]</b> bar ${bar} &middot; <b>${syl}</b> syllables &middot; vowels ${classes.map(c=>`<span class="vw" style="background:${VC[c]}" title="${vFriendly(c)}">${c}</span>`).join(" ")||"<i>none detected</i>"}`;
  renderForce(classes);renderPrediction(idx,lines);
}
function renderForce(vs){
  // OFF by default — forcing a vowel is an intentional override for special cases, not the
  // norm. Flip a switch ON only when you want to lock a bar-ending vowel during generation.
  $("forceRows").innerHTML=vs.length?vs.map(v=>
    `<div class="frow"><button class="toggle"><span class="k"></span></button><select class="inp">${VOPTS.map(o=>`<option ${o===v?"selected":""}>${o}</option>`).join("")}</select></div>`).join("")
    :'<div class="muted" style="margin-top:6px">Click a line with a rhyme vowel to load it here.</div>';
  $("forceRows").querySelectorAll(".toggle").forEach(b=>b.onclick=()=>b.classList.toggle("on"));
  $("forceNote").textContent=vs.length?"Off by default. Flip a switch to FORCE that bar-ending vowel when generating — even if it fights the natural scheme.":"";
}
/* every "?" dot opens the Guide */
document.querySelectorAll("[data-help]").forEach(d=>d.onclick=()=>{if(typeof showHelp==="function")showHelp(true);});

/* ---- generation: bring-your-own Anthropic key, runs in the browser (no server) ----
   Encodes the founder's methodology (14): rhythm-first; rhyme = vowel × syllable
   position; END rhyme is top priority; repeat rhythmic patterns; density set by the
   slider; lyrics should make sense but rhythm/rhyme lead. */
/* ---- multi-provider AI engine. The user picks Free (hosted open model) or brings their
   own Anthropic / OpenAI / Google key — stored ONLY in this browser, sent only to that
   provider. Each provider has a tiny request/response adapter. ---- */
const AI={providers:{
  free:    {label:"Free open model", keyLS:null, models:[]},
  groq:    {label:"Groq (fast · free tier)", keyLS:"ams.ai.key.groq", models:["llama-3.3-70b-versatile","llama-3.1-8b-instant","gemma2-9b-it"]},
  openrouter:{label:"OpenRouter (any model)", keyLS:"ams.ai.key.openrouter", models:["deepseek/deepseek-chat","openai/gpt-5.5","anthropic/claude-opus-4.8","meta-llama/llama-3.3-70b-instruct","google/gemini-2.0-flash-001"]},   // default = deepseek: cheap, fast, non-reasoning, excellent for lyrics
  anthropic:{label:"Anthropic", keyLS:"ams.ai.key.anthropic", models:["claude-sonnet-4-6","claude-opus-4-8","claude-haiku-4-5-20251001"]},
  openai:  {label:"OpenAI", keyLS:"ams.ai.key.openai", models:["gpt-4o","gpt-4o-mini","gpt-4.1","gpt-4.1-mini"]},
  google:  {label:"Google Gemini", keyLS:"ams.ai.key.google", models:["gemini-2.5-flash","gemini-2.5-pro","gemini-2.0-flash"]}
}};
const AI_PROV_LS="ams.ai.provider", AI_MODEL_LS="ams.ai.model.";
// migrate the old single Anthropic key into the new per-provider slot
if(!localStorage.getItem("ams.ai.key.anthropic")&&localStorage.getItem("ams.anthropic.key"))
  localStorage.setItem("ams.ai.key.anthropic",localStorage.getItem("ams.anthropic.key"));
function aiKeyOf(p){const prov=AI.providers[p];return prov&&prov.keyLS?localStorage.getItem(prov.keyLS):null;}
function aiModelOf(p){return localStorage.getItem(AI_MODEL_LS+p)||(AI.providers[p]&&AI.providers[p].models[0])||"";}
async function aiErr(res,p){let t="";try{t=await res.text();}catch(e){}
  if(res.status===401||res.status===403){const ks=AI.providers[p]&&AI.providers[p].keyLS;if(ks)localStorage.removeItem(ks);return new Error(`${AI.providers[p].label} key rejected (${res.status}) — set it again with the Key button.`);}
  return new Error(`${AI.providers[p].label} error ${res.status}: ${(t||"").slice(0,160)}`);}
/* one call → plain text out. Anthropic & Google allow direct browser calls; OpenAI usually
   does too. If a provider's CORS blocks the browser, that one needs the serve.py proxy. */
async function callLLM({provider,model,system,user,maxTokens=600}){
  const key=aiKeyOf(provider);
  if(provider!=="free"&&!key)throw new Error(`Add your ${AI.providers[provider].label} API key first (the Key button).`);
  if(provider==="anthropic"){
    const res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",
      headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
      body:JSON.stringify({model,max_tokens:maxTokens,system,messages:[{role:"user",content:user}]})});
    if(!res.ok)throw await aiErr(res,"anthropic");
    const d=await res.json();return (d.content||[]).map(c=>c.text||"").join("").trim();
  }
  if(provider==="openai"||provider==="groq"||provider==="openrouter"){   // all OpenAI-compatible — same shape, different base URL
    const url=provider==="groq"?"https://api.groq.com/openai/v1/chat/completions"
             :provider==="openrouter"?"https://openrouter.ai/api/v1/chat/completions"
             :"https://api.openai.com/v1/chat/completions";
    const headers={"content-type":"application/json","authorization":"Bearer "+key};
    if(provider==="openrouter"){headers["HTTP-Referer"]="https://songflow.pages.dev";headers["X-Title"]="Songflow Lyric Studio";}  // OpenRouter attribution (optional)
    const tokKey=provider==="openai"?"max_completion_tokens":"max_tokens";       // GPT-5.x rejects max_tokens; Groq/OpenRouter still take it
    const lbl=AI.providers[provider].label;
    let budget=maxTokens;
    for(let attempt=0;attempt<2;attempt++){
      const body={model,messages:[{role:"system",content:system},{role:"user",content:user}]}; body[tokKey]=budget;
      const res=await fetch(url,{method:"POST",headers,body:JSON.stringify(body)});
      if(res.ok){
        const d=await res.json();
        const ch=(d.choices&&d.choices[0])||{}; const txt=((ch.message&&ch.message.content)||"").trim();
        if(!txt){const fr=ch.finish_reason||"none";throw new Error(`the model returned no text (finish_reason: ${fr}${fr==="length"?" — it hit the token limit, likely a reasoning model; raise the limit or pick a faster model like deepseek/deepseek-chat":""})`);}
        return txt;
      }
      let bt=""; try{bt=await res.text();}catch(e){}
      // OpenRouter pre-reserves the WHOLE max_tokens against your balance; on a low balance it 402s
      // with "can only afford N". Retry ONCE within that budget — a few short bars need only ~150 tokens.
      if(res.status===402&&attempt===0){const m=bt.match(/afford\s+(\d+)/i);if(m){budget=Math.max(64,parseInt(m[1],10)-16);continue;}}
      if(res.status===401||res.status===403){const ks=AI.providers[provider]&&AI.providers[provider].keyLS;if(ks)localStorage.removeItem(ks);throw new Error(`${lbl} key rejected (${res.status}) — set it again with the Key button.`);}
      if(res.status===402)throw new Error(`${lbl}: not enough balance for this request. Add credits, or switch to a cheaper model like deepseek/deepseek-chat (paste it in the model box).`);
      throw new Error(`${lbl} error ${res.status}: ${(bt||"").slice(0,160)}`);
    }
  }
  if(provider==="google"){
    const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const res=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({system_instruction:{parts:[{text:system}]},contents:[{role:"user",parts:[{text:user}]}],generationConfig:{maxOutputTokens:maxTokens}})});
    if(!res.ok)throw await aiErr(res,"google");
    const d=await res.json();const cand=(d.candidates&&d.candidates[0])||{};
    return ((cand.content&&cand.content.parts)||[]).map(p=>p.text||"").join("").trim();
  }
  if(provider==="free")throw new Error("The free open-model engine isn't connected yet — pick Anthropic, OpenAI, or Google and add your key for now.");
  throw new Error("Unknown engine.");
}
/* engine selector UI wiring */
function aiSyncUI(){
  const sel=$("aiProvider");if(!sel)return;const p=sel.value,prov=AI.providers[p];
  const dl=$("aiModelList");if(dl)dl.innerHTML=(prov.models||[]).map(m=>`<option value="${m}">`).join("");
  const free=(p==="free");
  if($("aiModelRow"))$("aiModelRow").style.display=free?"none":"flex";
  if($("aiKey"))$("aiKey").style.display=free?"none":"";
  if(!free&&$("aiModel"))$("aiModel").value=aiModelOf(p);
  const note=$("ideaNote");
  if(note){
    if(free)note.innerHTML="<b>Free</b> open-model engine — no key needed. <i>(Hosting is being wired up. For now pick <b>Groq</b> below — it has a free tier and is fast — and add your own key.)</i>";
    else note.innerHTML=aiKeyOf(p)?`Using your <b>${prov.label}</b> key (stored only in this browser).`:`Add your <b>${prov.label}</b> API key with the &#128273; Key button — stored only in this browser, you pay ${prov.label} directly.`;
  }
}
if($("aiProvider")){
  $("aiProvider").value=localStorage.getItem(AI_PROV_LS)||"groq";   // a working keyed provider by default, not the not-yet-wired "free"
  $("aiProvider").onchange=()=>{localStorage.setItem(AI_PROV_LS,$("aiProvider").value);aiSyncUI();};
  if($("aiModel"))$("aiModel").onchange=()=>{const p=$("aiProvider").value;if(p!=="free")localStorage.setItem(AI_MODEL_LS+p,$("aiModel").value.trim());};
  if($("aiKey"))$("aiKey").onclick=async()=>{
    const p=$("aiProvider").value;if(p==="free"){toast("The free engine needs no key.");return;}
    const prov=AI.providers[p],cur=aiKeyOf(p)||"";
    const k=window.askText?await window.askText({title:prov.label+" API key",sub:"Stored only in this browser; sent only to "+prov.label+".",value:cur,placeholder:"paste your API key",okLabel:"Save key"}):prompt(prov.label+" API key:",cur);
    if(k===null)return;localStorage.setItem(prov.keyLS,(k||"").trim());toast(prov.label+" key saved.");aiSyncUI();
  };
  aiSyncUI();
}
const NSEL=$("ideaN");
NSEL.innerHTML=Array.from({length:16},(_,i)=>`<option value="${i+1}"${i+1===4?" selected":""}>${i+1} bar${i?"s":""}</option>`).join("");

function rhythmDirective(v){
  if(v<=15)return "VERY RHYTHMIC: percussive, syncopated phrasing — clustered short syllables, hard internal rhythm, internal rhymes mid-bar. (This shapes the FEEL WITHIN each bar's syllable count, NOT the count.)";
  if(v<=38)return "RHYTHMIC: busy, groove-forward phrasing with frequent internal stresses and the odd internal rhyme — within the bar's syllable count.";
  if(v<=62)return "BALANCED: a natural mix of held and quick syllables.";
  if(v<=85)return "DRAWN-OUT: spacious phrasing — held vowels, more space between hits.";
  return "CHOIR-LIKE: very sustained — long held vowels, hymn-like space.";
}
/* the CONTEXT axis (feelY): how much the lyric may trade literal meaning for a tighter meter. */
function contextDirective(y){
  if(y<=33)return "MEANING + METER TOGETHER: keep lines coherent and on-theme, telling a clear little story. This is where LEAD-INS earn their keep — whenever a line wants more words than the core target allows, ADD a 1-3 syllable lead-in (rule 4b) in a consistent pattern to make ROOM for the meaning, instead of cramming the bar or going abstract. Lean on lead-ins here.";
  if(y<=66)return "METER LEANS OVER MEANING: lock the syllable match and rhyme positions exactly; let imagery turn impressionistic where needed to keep the structure tight. Use lead-ins sparingly.";
  return "RHYTHM-FIRST SCAFFOLD: nail the meter and rhyme positions above all else; keep bars TIGHT with minimal lead-ins. Words may be abstract or placeholder — a rhythmic scaffold the writer rewrites for meaning. NEVER break a structural rule to make literal sense.";
}
/* paired-bar syllable check (the retry net). syllable count of one bar; which index pairs
   to compare for the active scheme; how much mismatch the context axis tolerates. */
// CORE syllable count: start → the rhyme anchor, EXCLUDING a trailing lead-in/pickup (e.g.
// "Imagination's reward, yeah" counts to "reward" = 7, the "yeah" is a free lead-in). Lead-ins flow
// into the next bar and never change a bar's target. Drives the gutter, section target, and matching.
function sylOfBar(line){
  const ws=String(line||"").trim().split(/\s+/).filter(Boolean);
  if(!ws.length)return 0;
  const ai=(typeof rhymeAnchorIdx==="function")?rhymeAnchorIdx(ws):ws.length-1; const last=ai<0?ws.length-1:ai;
  let n=0;for(let i=0;i<=last;i++)n+=syllables(ws[i]);
  return n;
}
function barPairs(count,schemeType){
  const pr=[];
  if(schemeType==="ABAB"){
    for(let g=0;g+3<count;g+=4){pr.push([g,g+2]);pr.push([g+1,g+3]);}   // COMPLETE 4-bar groups only; a 1-3 bar tail is left unpaired
  }else{
    for(let i=0;i+1<count;i+=2)pr.push([i,i+1]);                         // couplets; a trailing odd bar is left unpaired
  }
  return pr;
}
// floored at ±1: a held/stretched vowel or a pickup can always absorb one syllable (sung "le-eave"),
// so we never demand a literally identical count — only on-theme allows a looser ±2.
function sylTolerance(y){return y<=33?2:1;}
// anti-cliché: the imagery LLMs reach for by default — a dead giveaway. We steer away from these
// and toward concrete, specific nouns. (Full two-layer rhyme-word seeding is the deeper follow-up.)
const CLICHE="neon, shadows, whispers, echo, flames, fire, burning, ashes, soul, heart, dreams, infinite, eternal, forever, chains, broken, demons, angels, storm, thunder, lightning, phoenix, rise and fall, the edge, the void, abyss, electric, golden, diamond, shine, glow, wild and free, alive, scars, gravity, horizon";
function priorContext(){
  // the section + the preceding content bars WITHIN it (the template to extend). Collection STOPS at
  // this section's [tag] so a new chorus is never matched to the previous verse's syllable count.
  const lines=doc.innerText.split("\n");
  let idx=(selLine>=0&&selLine<lines.length)?selLine:lines.length-1;
  let sec="Verse"; const prior=[];
  for(let i=idx;i>=0;i--){
    const t=lines[i].trim(), m=t.match(/^\[(.+)\]$/);
    if(m){sec=m[1];break;}                              // reached this section's header → done
    if(t&&!isTag(t)&&prior.length<6)prior.unshift(t);   // keep the 6 nearest bars of THIS section
  }
  return {sec,prior};
}
/* detect the active end-rhyme scheme from the prior bars' end-vowels — the SAME judgement
   the on-screen guidance makes, so the generator continues exactly what you're writing. */
function endVowelOf(line){return vowelClass(rhymeAnchorWord(line));}
function analyzeScheme(vows){
  const n=vows.length;
  if(n<2)return {type:"open",altVowels:[]};
  const w=vows.slice(-6), m=w.length;                               // judge over a recent window, not just 3
  if(m>=4){                                                         // true ABAB: i matches i-2, adjacents differ
    const a=w[m-1],b=w[m-2],c=w[m-3],d=w[m-4];
    if(a===c&&b===d&&a!==b)return {type:"ABAB",altVowels:[a,b]};
  }
  if(w[m-1]===w[m-2])return {type:"couplet",altVowels:[w[m-1]]};    // adjacent pair shares a vowel
  if(m>=3&&w[m-1]===w[m-3]&&w[m-1]!==w[m-2])return {type:"ABAB",altVowels:[w[m-1],w[m-2]]};  // A B A → emerging cross
  return {type:"couplet",altVowels:[w[m-1]]};
}
/* ---- generation: reserve N placeholder bars at the cursor and pulse a glow over them until the
   real lyrics land. The cursor's (blank) line becomes the 1st bar; existing bars push down. ---- */
let _genGlow=null, _genGlowPos=null;
function genGlowHide(){if(_genGlow){_genGlow.remove();_genGlow=null;}_genGlowPos=null;}
function _genGlowPlace(){
  if(!_genGlow||!_genGlowPos)return;
  const dr=doc.getBoundingClientRect(), lineH=28, padTop=18, padL=18;
  _genGlow.style.left=(dr.left+padL)+"px"; _genGlow.style.width=Math.max(40,dr.width-padL*2)+"px";
  _genGlow.style.top=(dr.top+padTop+_genGlowPos.startLine*lineH-doc.scrollTop)+"px"; _genGlow.style.height=(_genGlowPos.nLines*lineH)+"px";
}
function genGlowOver(startLine,nLines){
  genGlowHide();
  const g=document.createElement("div"); g.className="genglow";
  document.body.appendChild(g); _genGlow=g; _genGlowPos={startLine,nLines};
  _genGlowPlace();
}
// keep the glow stuck to its bars while the page scrolls (it's a fixed overlay)
doc.addEventListener("scroll",()=>{if(_genGlow)_genGlowPlace();});
window.addEventListener("scroll",()=>{if(_genGlow)_genGlowPlace();},true);
window.addEventListener("resize",()=>{if(_genGlow)_genGlowPlace();});
function genReserveSlot(n){
  pushUndo();
  const lines=doc.innerText.split("\n");
  let off=caretOffset(); if(off==null)off=(lastCaret!=null?lastCaret:doc.innerText.length);
  const ci=doc.innerText.slice(0,off).split("\n").length-1;            // caret line index
  const blank=!lines[ci]||!lines[ci].trim();
  const startLine=blank?ci:ci+1;                                       // the blank line becomes bar 1, else go below the content line
  const head=lines.slice(0,startLine), tail=lines.slice(ci+1);
  doc.textContent=[...head,...Array(n).fill(""),...tail].join("\n");
  if(rhymeOn)paintRhymes();else update();
  const startOff=head.join("\n").length+(head.length?1:0);
  try{setCaret(startOff);}catch(e){}
  genGlowOver(startLine,n);
  return {startLine,n};
}
function genFillSlot(slot,bars){
  const lines=doc.innerText.split("\n");
  lines.splice(slot.startLine,slot.n,...bars);                        // swap the placeholders for the real bars
  doc.textContent=lines.join("\n");
  if(rhymeOn)paintRhymes();else update();
  try{tagRegions();}catch(e){}
  try{setCaret(lines.slice(0,slot.startLine+bars.length).join("\n").length);}catch(e){}
}
function genCancelSlot(slot){
  const lines=doc.innerText.split("\n");
  lines.splice(slot.startLine,slot.n);
  doc.textContent=lines.join("\n");
  if(rhymeOn)paintRhymes();else update();
}
async function generateLyrics(){
  const provider=($("aiProvider")&&$("aiProvider").value)||localStorage.getItem(AI_PROV_LS)||"free";
  const model=($("aiModel")&&$("aiModel").value.trim())||aiModelOf(provider);
  if(provider!=="free"&&!aiKeyOf(provider)){               // no key yet → open the key dialog
    const note=$("ideaNote");if(note){note.className="muted";note.style.color="var(--danger)";note.textContent=`Add your ${AI.providers[provider].label} key first.`;}
    if($("aiKey"))$("aiKey").click();return;
  }
  const n=+NSEL.value||4;
  // syllable target: only when the Force-syllables override is on; otherwise match prior bars
  const targetSyl=(sylForceOn()&&+($("sylTarget").value||0)>0)?+$("sylTarget").value:null;
  const rhythm=(typeof feelX!=="undefined")?feelX:50;     // X axis: packed ↔ sustained
  const ctxY=(typeof feelY!=="undefined")?feelY:30;       // Y axis: on-theme ↔ rhythm-first
  const tol=sylTolerance(ctxY);                           // how much paired-bar mismatch we tolerate
  const {sec,prior}=priorContext();
  // bar LENGTH is anchored: a forced override, else this section's established length, else a
  // rough count from the X axis. The packed/sustained feel must NOT change this count.
  const priorSyls=prior.map(sylOfBar).filter(x=>x>0);
  const sectionSyl=priorSyls.length?Math.round(priorSyls.slice(-4).reduce((a,b)=>a+b,0)/Math.min(4,priorSyls.length)):0;
  const sylTargetEff=targetSyl||sectionSyl||(rhythm<=25?8:rhythm<=50?6:rhythm<=75?5:4);
  const forced=[...$("forceRows").querySelectorAll(".frow")].filter(r=>r.querySelector(".toggle.on"))
    .map(r=>r.querySelector("select").value);
  // detect the live scheme from the bars above so the model continues the same one
  const priorVowels=prior.map(endVowelOf).filter(Boolean);
  const scheme=analyzeScheme(priorVowels);
  const schemeLine=priorVowels.length
    ? `ACTIVE SCHEME — the bars above end on these vowels (oldest→newest): ${priorVowels.join(", ")}. Read it as ${scheme.type==="ABAB"?`an ALTERNATING / cross rhyme (ABAB): a vowel is answered the bar AFTER next, so a pair lands every other bar. Continue it by alternating end-vowels between ${scheme.altVowels.join(" and ")}`:scheme.type==="couplet"?`a COUPLET (AABB): adjacent bars pair; close an open couplet on the vowel it opened with`:"open — set a clear end-rhyme the next bar can answer"}. Continue this exact scheme.`
    : `No scheme yet — open with a clear end-rhyme vowel the next bar can answer.`;
  // anti-cliché seeding: hand the model the writer's OWN rhyme palette (same lists as the on-screen
  // rhyme chips) for the active scheme vowels, so end-words come from quality real rhymes, not pet defaults.
  const seedVows=[...new Set([...(scheme.altVowels||[]),...priorVowels])].filter(Boolean).slice(0,3);
  const seedLine=seedVows.map(v=>{const ws=[...((NEAR[v]||[])),...((SLANT[v]||[]))].slice(0,12);return ws.length?`${v} → ${ws.join(", ")}`:"";}).filter(Boolean).join("   |   ");
  const sys=`You are a master lyricist writing to a strict rhythmic + rhyme methodology. RULES, in priority order:
1. RHYTHM FIRST. Build a complementary rhythmic pattern and make the words ride it; echo the rhythmic pattern of the prior bars.
2. RHYME = matching VOWEL SOUNDS landing on the SAME position across bars. The END rhyme (final stressed vowel of the bar) is the HIGHEST-priority pair; strong internal pairs are a bonus.
3. PAIRED BARS LOCK TOGETHER. Two rhyming bars MUST have the SAME number of syllables, and the rhyme vowel must sit the SAME number of syllables from the downbeat in both — so the rhyme lands on the SAME beat. The rhyme should fall on a STRONG position (beat 1, or a 1/2, 1/4, or 1/8 subdivision), never a weak off-beat. There are usually many word choices that satisfy this — find one.
4. A syllable-count difference between paired bars is allowed ONLY when a SUSTAINED/held vowel on a strong beat, or a PICKUP syllable before the downbeat, absorbs it AND the rhyme still lands on the same spot. Otherwise keep the counts equal.
4b. LEAD-INS (pickups): 1-3 short trailing syllables AFTER the rhyme word that flow INTO the next bar (e.g. "...knees, oh", or splitting a word across the barline: end one bar on "...the I-" and start the next on "magination..."). Lead-ins do NOT count toward the syllable target — they are FREE extra room to add words for meaning and flow, the release valve when a line needs more than the target allows. The rhyme still anchors on the word BEFORE the lead-in. If you use them, make it a CONSISTENT PATTERN — after EVERY bar, or EVERY OTHER bar — never randomly on one isolated bar.
5. RHYME STRUCTURE — COUPLET (AABB, adjacent bars rhyme) or CROSS / ALTERNATING (ABAB, answered every other bar). ${schemeLine}
6. VARY THE RHYME ACROSS THESE BARS: move through SEVERAL end-vowels — a new rhyme sound roughly every couplet (2 bars). Do NOT end more than 2 bars in a row on the same vowel unless deliberately building a list. ${n>=4?`So ${n} bars should use ~${Math.max(2,Math.round(n/2))} different end-vowels, not one.`:""} (A run of ≥8 bars on one vowel reads as monotonous — never do that.)
7. ${rhythmDirective(rhythm)}
8. ${contextDirective(ctxY)}
9. LENGTH: each bar's CORE (start → rhyme word, NOT counting any lead-in) ≈ ${sylTargetEff} syllables (1 line = 1 bar)${sectionSyl&&!targetSyl?` — this section's bars are ${sectionSyl}; MATCH that core length. Rule 7 sets the FEEL, never the length; lead-ins (4b) add words WITHOUT changing this count.`:"."}
10. ${forced.length?`HARD OVERRIDE (intentional rule-break for effect): the END word of EVERY bar MUST carry one of these vowel sounds (ARPABET): ${forced.join(", ")}. Examples: ${forced.flatMap(v=>(NEAR[v]||[]).slice(0,3)).join(", ")}. This overrides rule 5 — obey it even if it fights the natural scheme.`:"Choose end-rhyme vowels that extend the prior bars' scheme per rule 5."}
11. FRESHNESS — avoid generic AI-lyric clichés and pet imagery (e.g. ${CLICHE}). Reach for concrete, specific, surprising nouns and images over abstract emotion words; don't reuse end-words the prior bars already used.
${seedLine?`12. PREFERRED RHYMES — for a scheme vowel's end-word, lean on these real options from the writer's palette over your usual go-to rhymes (not mandatory, but prefer them to stay fresh and on-vowel): ${seedLine}.\n`:""}${directionClauses(sec)}
Output ONLY the ${n} lyric ${n>1?"bars":"bar"}, one per line. No section tags, no numbering, no commentary, no quotes.`;
  const usr=(prior.length?`Section: [${sec}]\nPrior bars to extend (match their rhythm & rhyme scheme):\n${prior.join("\n")}\n\n`:`Section: [${sec}]\n\n`)+
    `Write ${n} new bar${n>1?"s":""} that continue this section.`;
  const note=$("ideaNote"),btn=$("ideaGo");
  note.className="muted";note.style.color="";note.textContent="Generating…";btn.disabled=true;
  const myGen=++_genSeq;                              // cancellation token — undo bumps _genSeq to abort this run
  const slot=genReserveSlot(n);                       // glowing placeholder bars at the cursor while we wait
  // validation+retry: when vowels are FORCED (a checkable contract), verify every generated
  // bar ends on one of them; if the model drifts, silently re-ask with a stricter fix. Works
  // with any provider. (No forced vowels → no hard check; we don't second-guess free writing.)
  const exWords=forced.flatMap(v=>(NEAR[v]||[]).slice(0,3));
  const endsOk=bars=>!forced.length||bars.every(b=>forced.includes(endVowelOf(b)));
  // LENGTH check — every bar must land within tolerance of the section's syllable target, so the
  // packed/sustained feel can't blow the bars out to double length. (Equal lengths => pairs match too.)
  const matchBad=bars=>bars.map(b=>({b,c:sylOfBar(b)})).filter(x=>Math.abs(x.c-sylTargetEff)>tol)
    .map(x=>`"${x.b}" (${x.c} syl, want ~${sylTargetEff})`);
  const matchOk=bars=>matchBad(bars).length===0;
  // VARIETY check — flag a run of >2 generated bars on the same end-vowel (monotonous mono-rhyme).
  const varyBad=bars=>{let run=1;for(let i=1;i<bars.length;i++){if(endVowelOf(bars[i])===endVowelOf(bars[i-1])){run++;if(run>2)return true;}else run=1;}return false;};
  try{
    let bars=null;const maxTries=(forced.length||sylTargetEff)?3:1;   // a length target is always set → always allow retries
    for(let attempt=1;attempt<=maxTries;attempt++){
      let fix="";
      if(attempt>1&&bars){
        if(!endsOk(bars))fix+=`\n\nYour previous attempt broke the end-rhyme rule. EVERY one of the ${n} bars MUST end on a word whose stressed vowel is ${forced.join(" or ")} (e.g. ${exWords.join(", ")}). Rewrite all ${n} bars, fixing every final word.`;
        const bad=matchBad(bars);
        if(bad.length)fix+=`\n\nWRONG BAR LENGTH: ${bad.join("; ")}. EVERY bar must be about ${sylTargetEff} syllables to match this section${tol?` (±${tol})`:""}. Rewrite all ${n} bars to that length — keep them short, do NOT pack extra syllables.`;
        if(varyBad(bars))fix+=`\n\nTOO MONOTONOUS: too many bars end on the same vowel sound. Change the end-rhyme vowel every couplet (about ${Math.max(2,Math.round(n/2))} different rhyme sounds across the ${n} bars).`;
      }
      const out=await callLLM({provider,model,system:sys,user:usr+fix,maxTokens:2000});
      if(!out)throw new Error("empty response");
      bars=out.split("\n").map(s=>s.trim()).filter(Boolean).slice(0,n);
      if(endsOk(bars)&&matchOk(bars)&&!varyBad(bars))break;
      if(attempt<maxTries)note.textContent=`Tightening the rhythm (try ${attempt+1})…`;
    }
    if(_genSeq===myGen){                              // still our run (not cancelled by an undo mid-flight)
      genFillSlot(slot,bars);                         // swap the glowing placeholders for the real bars
      const vDrift=!endsOk(bars), mDrift=!matchOk(bars);
      note.style.color="";note.textContent=`Generated ${bars.length} bar(s).`+(vDrift?" Couldn't fully lock the forced vowel — tweak as needed.":mDrift?" A bar's length is still a little off — tweak as needed.":" Edit freely — they're in your document.");
    }
  }catch(err){if(_genSeq===myGen){genCancelSlot(slot);note.className="muted";note.style.color="var(--danger)";note.textContent="Generation failed: "+err.message;}}
  if(_genSeq===myGen){genGlowHide();btn.disabled=false;}
}
function insertBarsAtCaret(bars){
  pushUndo();
  const text=doc.innerText;
  let off=(typeof caretOffset==="function"&&caretOffset()!=null)?caretOffset():text.length;
  // snap to the end of the caret's line so we insert whole bars
  let nl=text.indexOf("\n",off);if(nl<0)nl=text.length;
  const before=text.slice(0,nl), after=text.slice(nl);
  const ins=(before&&!before.endsWith("\n")?"\n":"")+bars.join("\n");
  const next=before+ins+after;
  doc.textContent=next;
  if(rhymeOn)paintRhymes();else update();
  if(typeof setCaret==="function")setCaret((before+ins).length);
}
$("ideaGo").onclick=generateLyrics;

/* ================= highlight → Replace / Add-after =================
   Select bars in the editor → a popover offers Replace (rewrite to the selection's rhythm/rhyme
   skeleton, governed by two fidelity dials) or Add after (normal continuation). Reuses the engine,
   the quadrant feel, and the validation/retry from generateLyrics. */
/* shared rewrite core: given a list of original bars, return N fresh bars matching each one's
   rhythm/rhyme skeleton (per the two dials). Used by BOTH contiguous Replace and multi-select. */
async function _rewriteBars(bars,vMatch,sMatch){
  const provider=($("aiProvider")&&$("aiProvider").value)||localStorage.getItem(AI_PROV_LS)||"free";
  const model=($("aiModel")&&$("aiModel").value.trim())||aiModelOf(provider);
  const note=$("selNote");
  if(provider!=="free"&&!aiKeyOf(provider)){if(note){note.style.color="var(--danger)";note.textContent=`Add your ${AI.providers[provider].label} key first.`;}if($("aiKey"))$("aiKey").click();return null;}
  bars=bars.filter(l=>l&&l.trim()&&!isTag(l));
  const n=bars.length;
  if(!n){if(note){note.style.color="var(--danger)";note.textContent="Select at least one lyric line.";}return null;}
  const skel=bars.map(l=>({syl:sylOfBar(l),vow:vowelClass(rhymeAnchorWord(l))}));
  const vHigh=vMatch>=50,vHard=vMatch>=80,sHigh=sMatch>=50;
  const sTol=sMatch>=80?1:sMatch>=50?2:99;                       // syllable tolerance from the dial (floored at 1)
  const fx=(typeof feelX!=="undefined")?feelX:50, fy=(typeof feelY!=="undefined")?feelY:30;
  const specs=skel.map((s,i)=>`Bar ${i+1}: ${sHigh?`~${s.syl} syllables`:"free length"}${vHigh&&s.vow?`, end-rhyme vowel ${s.vow}`:""}`).join("\n");
  const sys=`You are REWRITING song lyrics: produce ${n} NEW bars with fresh words and a NEW meaning, while matching the original bars' rhythm/rhyme skeleton as specified. Priorities:
- ${rhythmDirective(fx)}
- ${contextDirective(fy)}
- ${sHigh?`Match each bar's syllable count to its target (within ${sTol}; a held vowel or pickup may absorb a one-syllable difference).`:"Syllable counts are free."}
- ${vHigh?`${vHard?"MUST":"Prefer to"} end each bar on a word whose final stressed vowel matches that bar's target ARPABET vowel, preserving the rhyme scheme.`:"Rhymes are free — choose new end-rhymes."}
- FRESHNESS: avoid AI clichés (${CLICHE}); concrete, specific imagery; do NOT reuse the original's words.
Per-bar targets:
${specs}
${directionClauses((typeof priorContext==="function")?priorContext().sec:"")}
Output ONLY the ${n} new bars, one per line. No tags, numbering, quotes, or commentary.`;
  const usr=`Original bars (rewrite with NEW meaning, keep the structure):\n${bars.join("\n")}\n\nWrite the ${n} new bars now.`;
  const vowOk=o=>!vHard||o.every((b,i)=>!skel[i].vow||endVowelOf(b)===skel[i].vow);
  const cntBad=o=>!sHigh?[]:o.map((b,i)=>({i,d:Math.abs(sylOfBar(b)-skel[i].syl)})).filter(x=>x.d>sTol);
  if(note){note.style.color="";note.textContent="Rewriting…";} const go=$("selGen"); if(go)go.disabled=true;
  try{
    let out=null;const maxTries=(vHard||sHigh)?3:1;
    for(let a=1;a<=maxTries;a++){
      let fix="";
      if(a>1&&out){
        if(!vowOk(out))fix+=`\n\nFix the end-rhymes — each bar must end on its target vowel (${skel.map((s,i)=>`bar ${i+1}=${s.vow}`).join(", ")}).`;
        const cb=cntBad(out); if(cb.length)fix+=`\n\nFix syllable counts: ${cb.map(x=>`bar ${x.i+1} ~${skel[x.i].syl} (was ${sylOfBar(out[x.i])})`).join("; ")}.`;
      }
      const res=await callLLM({provider,model,system:sys,user:usr+fix,maxTokens:2000});
      out=(res||"").split("\n").map(s=>s.trim()).filter(Boolean).slice(0,n);
      if(out.length&&vowOk(out)&&cntBad(out).length===0)break;
      if(a<maxTries&&note)note.textContent=`Tightening the match (try ${a+1})…`;
    }
    if(!out||!out.length)throw new Error("empty response");
    if(go)go.disabled=false; return out;
  }catch(err){if(note){note.style.color="var(--danger)";note.textContent="Failed: "+err.message;} if(go)go.disabled=false; return null;}
}
async function replaceSelection(ls,le,selLines,vMatch,sMatch){
  const barIdx=selLines.map((l,i)=>(l.trim()&&!isTag(l))?i:-1).filter(i=>i>=0);   // only lyric lines; tags/blanks preserved
  const out=await _rewriteBars(barIdx.map(i=>selLines[i]),vMatch,sMatch);
  if(!out)return;
  pushUndo();
  const rebuilt=selLines.slice(); out.forEach((b,k)=>{if(barIdx[k]!=null)rebuilt[barIdx[k]]=b;});
  const text=doc.innerText; doc.textContent=text.slice(0,ls)+rebuilt.join("\n")+text.slice(le);
  if(rhymeOn)paintRhymes();else update(); try{tagRegions();}catch(e){}
  if(typeof saveProjectState==="function")saveProjectState();
  hideSelPop();
}
/* MULTI-SELECT: Ctrl/Cmd+click bars to toggle them into a set the app tracks itself (the browser
   can't hold a non-contiguous selection in an editable). Replace then rewrites ALL of them. */
let _multiSel=new Set(), _multiEls=[];
function _multiHide(){_multiEls.forEach(e=>e.remove());_multiEls=[];}
function renderMultiSel(){
  _multiHide(); if(!_multiSel.size)return;
  const dr=doc.getBoundingClientRect(), lineH=28, padTop=18, padL=14;
  _multiSel.forEach(idx=>{
    const top=dr.top+padTop+idx*lineH-doc.scrollTop;
    if(top<dr.top-2||top>dr.bottom-6)return;                    // off-screen → skip
    const d=document.createElement("div"); d.className="barselHi";
    d.style.left=(dr.left+padL)+"px"; d.style.width=Math.max(20,dr.width-padL*2)+"px"; d.style.top=top+"px";
    document.body.appendChild(d); _multiEls.push(d);
  });
}
function multiClear(){_multiSel.clear();_multiHide();}
async function replaceMultiSel(vMatch,sMatch){
  const lines=doc.innerText.split("\n");
  const idxs=[..._multiSel].sort((a,b)=>a-b).filter(i=>{const t=(lines[i]||"").trim();return t&&!isTag(t);});
  if(!idxs.length)return;
  const out=await _rewriteBars(idxs.map(i=>lines[i]),vMatch,sMatch);
  if(!out)return;
  pushUndo();
  const l2=doc.innerText.split("\n");
  idxs.forEach((idx,k)=>{if(out[k]!=null&&idx<l2.length)l2[idx]=out[k];});
  doc.textContent=l2.join("\n");
  if(rhymeOn)paintRhymes();else update(); try{tagRegions();}catch(e){}
  if(typeof saveProjectState==="function")saveProjectState();
  multiClear(); hideSelPop();
}
function showMultiPop(){
  const p=$("selPop"); if(!p||!_multiSel.size){hideSelPop();return;}
  _selCap={multi:true};
  const dr=doc.getBoundingClientRect(), idx=Math.max(..._multiSel), top=dr.top+18+idx*28-doc.scrollTop;
  p.style.display="block"; $("selRepl").style.display="block";   // multi-sel → straight to the dials
  const cnt=$("selCount"); if(cnt)cnt.textContent=`${_multiSel.size} bar${_multiSel.size>1?"s":""} selected`;
  const pw=p.offsetWidth||230, ph=p.offsetHeight||120;
  p.style.left=Math.min(window.innerWidth-pw-8,Math.max(8,dr.left+dr.width/2-pw/2))+"px";
  let y=top+34; if(y+ph>window.innerHeight-8)y=Math.max(8,top-ph-6); p.style.top=y+"px";
}
// Ctrl/Cmd+click a lyric line → toggle it in the multi-select set
doc.addEventListener("click",e=>{
  if(e.ctrlKey||e.metaKey){
    const dr=doc.getBoundingClientRect();
    const idx=Math.floor((e.clientY-dr.top-18+doc.scrollTop)/28);
    const lines=doc.innerText.split("\n"); const t=(lines[idx]||"").trim();
    if(t&&!isTag(t)){e.preventDefault();
      if(_multiSel.has(idx))_multiSel.delete(idx); else _multiSel.add(idx);
      renderMultiSel(); if(_multiSel.size)showMultiPop(); else hideSelPop();}
    return;
  }
  if(_multiSel.size){multiClear();hideSelPop();}                 // a plain click cancels the multi-select
});
doc.addEventListener("scroll",()=>{if(_multiSel.size){renderMultiSel();showMultiPop();}});
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&_multiSel.size){multiClear();hideSelPop();}});
/* selection → editor-text offsets. #doc is white-space:pre-wrap, so newlines are literal chars and
   Range.toString() length lines up with doc.innerText offsets. */
let _selCap=null;
function selOffsets(){
  const sel=window.getSelection(); if(!sel||!sel.rangeCount)return null;
  const r=sel.getRangeAt(0); if(r.collapsed||!doc.contains(r.commonAncestorContainer))return null;
  const pre=document.createRange(); pre.selectNodeContents(doc);
  try{pre.setEnd(r.startContainer,r.startOffset);}catch(e){return null;} const start=pre.toString().length;
  try{pre.setEnd(r.endContainer,r.endOffset);}catch(e){return null;} const end=pre.toString().length;
  return end>start?{start,end}:null;
}
function hideSelPop(){const p=$("selPop"); if(p)p.style.display="none"; _selCap=null;}
function showSelPop(){
  const p=$("selPop"); if(!p)return;
  if(_multiSel.size)return;                          // multi-select owns the popover; ignore browser-selection
  const o=selOffsets(); if(!o){hideSelPop();return;}
  const text=doc.innerText;
  const lstart=text.lastIndexOf("\n",o.start-1)+1; let lend=text.indexOf("\n",o.end); if(lend<0)lend=text.length;
  const lines=text.slice(lstart,lend).split("\n");
  if(!lines.some(l=>l.trim()&&!isTag(l))){hideSelPop();return;}
  _selCap={ls:lstart,le:lend,lines};
  const rect=window.getSelection().getRangeAt(0).getBoundingClientRect();
  const cnt=$("selCount"); if(cnt)cnt.textContent="";          // contiguous selection → no multi-count label
  p.style.display="block"; $("selRepl").style.display="none";
  const pw=p.offsetWidth||230, ph=p.offsetHeight||40;
  p.style.left=Math.min(window.innerWidth-pw-8,Math.max(8,rect.left+rect.width/2-pw/2))+"px";
  let y=rect.top-ph-8; if(y<8)y=rect.bottom+8; p.style.top=y+"px";
}
doc.addEventListener("mouseup",()=>setTimeout(showSelPop,0));
doc.addEventListener("keyup",e=>{if(e.key==="Shift"||e.shiftKey)setTimeout(showSelPop,0);});
document.addEventListener("mousedown",e=>{const p=$("selPop");if(p&&p.style.display!=="none"&&!p.contains(e.target)&&!doc.contains(e.target)){hideSelPop();if(_multiSel.size)multiClear();}},true);
if($("selReplace"))$("selReplace").onclick=()=>{$("selRepl").style.display="block";};
if($("selAdd"))$("selAdd").onclick=()=>{const cap=_selCap;if(!cap)return;try{setCaret(cap.le);}catch(e){}hideSelPop();if(typeof generateLyrics==="function")generateLyrics();};
if($("selGen"))$("selGen").onclick=()=>{const v=+($("selVowel").value||0),s=+($("selSyl").value||0);
  if(_multiSel.size){replaceMultiSel(v,s);return;}
  const cap=_selCap;if(!cap||cap.multi)return;replaceSelection(cap.ls,cap.le,cap.lines,v,s);};
function syncSelVals(){if($("selVowelV"))$("selVowelV").textContent=($("selVowel").value||0)+"%";if($("selSylV"))$("selSylV").textContent=($("selSyl").value||0)+"%";}
if($("selVowel"))$("selVowel").oninput=syncSelVals;
if($("selSyl"))$("selSyl").oninput=syncSelVals;
syncSelVals();

/* ---- init ---- */
syncDocSel();
update();
if(rhymeOn)paintRhymes();
if(typeof restoreProjectState==="function")restoreProjectState();   // bring back this project's saved audio + settings on load
