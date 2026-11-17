/* Prompter — recording and playback of run-throughs.
   - Rec: records your voice while the prompter runs (pauses when you pause),
     and logs which line was at the reading line every quarter second.
   - Playback: plays a recording and scrolls the script along with it.
   Recordings stay on this device (IndexedDB). They aren't in backup files or Google Drive. */
'use strict';

/* ---------- storage ---------- */
const Media = (() => {
  let dbp;
  function db() {
    dbp = dbp || new Promise((res, rej) => {
      const r = indexedDB.open('prompter-media', 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore('takes', { keyPath: 'id' });
        s.createIndex('script', 'scriptId');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => { dbp = null; rej(r.error); };
    });
    return dbp;
  }
  async function run(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('takes', mode);
      const out = fn(t.objectStore('takes'));
      t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('Storage is full'));
    });
  }
  return {
    put: (take) => run('readwrite', (s) => s.put(take)),
    get: (id) => run('readonly', (s) => s.get(id)),
    remove: (id) => run('readwrite', (s) => s.delete(id)),
    list: (scriptId) => run('readonly', (s) => s.index('script').getAll(scriptId))
      .then((a) => (a || []).sort((x, y) => y.date - x.date)),
    async removeForScript(scriptId) {
      const all = await this.list(scriptId);
      for (const t of all) await this.remove(t.id);
    },
  };
})();

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/* ---------- recorder ---------- */
const Rec = (() => {
  const R = { state: 'off', stream: null, rec: null, chunks: [], elapsed: 0, nextSample: 0, keys: [], keyIdx: new Map(), t: [], k: [], f: [], mime: '', starting: false };

  const supported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  const wanted = () => !!(P.s && P.s.settings.record);
  const active = () => R.state === 'recording' || R.state === 'paused';

  function pickMime() {
    for (const m of ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch {}
    }
    return '';
  }

  async function start() {
    if (R.starting || active()) return;
    R.starting = true;
    try {
      R.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = pickMime();
      R.rec = new MediaRecorder(R.stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
      R.mime = R.rec.mimeType || mime || 'audio/mp4';
      const chunks = [];
      R.chunks = chunks;
      R.rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      Object.assign(R, { elapsed: 0, nextSample: 0, keys: [], keyIdx: new Map(), t: [], k: [], f: [], scriptId: P.s.id, title: P.s.title, startedAt: Date.now() });
      R.rec.start(1000);
      R.state = 'recording';
      if (!P.playing) pause_();
      sample(true);
    } catch (e) {
      stopTracks();
      R.state = 'off';
      if (P.s) { P.s.settings.record = false; saveSettingsSoon(); }
      toast(e && e.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow it for Prompter in Settings, then tap Rec again.'
        : 'Couldn’t start recording on this device.', 6000);
    } finally {
      R.starting = false;
      paint();
    }
  }

  function pause_() {
    if (R.state === 'recording') { try { R.rec.pause(); } catch {} R.state = 'paused'; }
    paint();
  }
  function resume() {
    if (R.state === 'paused') { try { R.rec.resume(); } catch {} R.state = 'recording'; }
    paint();
  }

  function stopTracks() {
    if (R.stream) R.stream.getTracks().forEach((t) => t.stop());
    R.stream = null;
  }

  /** Remember which line is at the reading line (by line key, so it survives text edits). */
  function sample(force) {
    if (!force && R.elapsed < R.nextSample) return;
    R.nextSample = R.elapsed + 0.25;
    const a = anchorAt();
    if (!a) return;
    const key = P.doc.items[a.i] && P.doc.items[a.i].key;
    if (!key) return;
    let ki = R.keyIdx.get(key);
    if (ki == null) { ki = R.keys.length; R.keys.push(key); R.keyIdx.set(key, ki); }
    R.t.push(Math.round(R.elapsed * 100) / 100);
    R.k.push(ki);
    R.f.push(Math.round(a.frac * 1000) / 1000);
  }

  /** Stop and save the current recording (if any). */
  function finish() {
    if (!active()) { stopTracks(); paint(); return Promise.resolve(); }
    const rec = R.rec, chunks = R.chunks, info = { ...R, keys: R.keys.slice(), t: R.t.slice(), k: R.k.slice(), f: R.f.slice() };
    R.state = 'off';
    paint();
    return new Promise((res) => {
      rec.onstop = async () => {
        stopTracks();
        const blob = new Blob(chunks, { type: info.mime });
        if (info.elapsed < 3 || !blob.size) { res(); return; }
        const take = {
          id: 'take-' + Date.now().toString(36),
          scriptId: info.scriptId,
          title: info.title,
          date: info.startedAt,
          duration: info.elapsed,
          mime: info.mime,
          size: blob.size,
          keys: info.keys, t: info.t, k: info.k, f: info.f,
          blob,
        };
        try {
          await Media.put(take);
          toast(`Recording saved (${fmt(info.elapsed)}). Find it under Notes → Recordings.`, 4500);
        } catch {
          toast('Couldn’t save the recording — this device may be out of storage.', 6000);
        }
        if (P.s && !$('#panel-notes').hidden) renderRecordings();
        res();
      };
      try { if (rec.state === 'paused') rec.resume(); rec.stop(); } catch { res(); }
    });
  }

  function paint() {
    const b = $('#b-rec');
    if (!b) return;
    const on = wanted();
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('live', R.state === 'recording');
    const pill = $('#rec-pill');
    pill.hidden = !active();
    pill.classList.toggle('paused', R.state === 'paused');
    $('#rec-time').textContent = fmt(R.elapsed);
  }

  return {
    supported,
    active,
    /** Rec button */
    toggle() {
      if (!supported()) { toast('This browser can’t record audio.'); return; }
      P.s.settings.record = !P.s.settings.record;
      saveSettingsSoon();
      if (P.s.settings.record) {
        toast(P.playing ? 'Recording…' : 'Recording is on — it starts when you press Start.', 3000);
        if (P.playing) start();
      } else {
        finish();
      }
      paint();
    },
    onPlay() { if (!wanted() || !supported()) return; if (R.state === 'paused') resume(); else start(); },
    onPause() { pause_(); },
    onFrame(dt) {
      if (R.state !== 'recording') return;
      R.elapsed += dt;
      sample(false);
      const s = Math.floor(R.elapsed);
      if (s !== R.shown) { R.shown = s; $('#rec-time').textContent = fmt(R.elapsed); }
    },
    finish,
    paint,
  };
})();

/* ---------- playback ---------- */
const Review = (() => {
  const V = { take: null, audio: null, url: '', raf: 0, rates: [1, 1.25, 1.5, 2], rate: 0 };

  const active = () => !!V.take;

  function pxOf(ki, frac) {
    const key = V.take.keys[ki];
    const i = P.keyIndex.get(key);
    if (i == null) return null;
    const e = P.itemEls[i];
    return e ? e.offsetTop + frac * e.offsetHeight - P.readY : null;
  }

  /** Where the reading line was at time t (interpolated between samples). */
  function posAt(t) {
    const T = V.take.t;
    if (!T.length) return P.pos;
    let lo = 0, hi = T.length - 1;
    if (t <= T[0]) lo = hi = 0;
    else {
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (T[mid] <= t) lo = mid; else hi = mid - 1; }
      hi = Math.min(lo + 1, T.length - 1);
    }
    let a = lo;
    let pa = pxOf(V.take.k[a], V.take.f[a]);
    while (pa == null && a > 0) { a--; pa = pxOf(V.take.k[a], V.take.f[a]); } // line was edited away
    if (pa == null) return P.pos;
    const pb = pxOf(V.take.k[hi], V.take.f[hi]);
    if (pb == null || hi === lo || T[hi] === T[lo]) return pa;
    const r = Math.min(1, Math.max(0, (t - T[lo]) / (T[hi] - T[lo])));
    return pa + (pb - pa) * r;
  }

  function loop() {
    if (!V.audio) return;
    if (!V.audio.paused) setPos(posAt(V.audio.currentTime));
    paintBar();
    V.raf = requestAnimationFrame(loop);
  }

  function paintBar() {
    const a = V.audio;
    const dur = isFinite(a.duration) && a.duration > 0 ? a.duration : V.take.duration;
    $('#pb-play').textContent = a.paused ? '▶ Play' : '❚❚ Pause';
    const s = Math.floor(a.currentTime);
    if (s !== V.shown || V.durShown !== Math.floor(dur)) {
      V.shown = s; V.durShown = Math.floor(dur);
      $('#pb-time').textContent = `${fmt(a.currentTime)} / ${fmt(dur)}`;
    }
    const seek = $('#pb-seek');
    seek.max = String(dur);
    if (!V.dragging) seek.value = String(a.currentTime);
    $('#pb-rate').textContent = V.rates[V.rate] + '×';
  }

  async function open(id) {
    const take = await Media.get(id);
    if (!take || !take.blob) { toast('That recording couldn’t be found.'); return; }
    if (P.playing) pause();
    await Rec.finish();
    exit(true);
    closeAllPanels();
    V.take = take;
    V.url = URL.createObjectURL(take.blob);
    V.audio = new Audio(V.url);
    V.audio.preload = 'auto';
    V.audio.playbackRate = V.rates[V.rate];
    V.audio.addEventListener('ended', () => paintBar());
    document.body.classList.add('reviewing');
    $('#pb-title').textContent = 'Recording · ' + fmtDate(take.date, true);
    $('#hint').hidden = true;
    updateUI();
    setPos(posAt(0));
    V.raf = requestAnimationFrame(loop);
    V.audio.play().catch(() => {}); // a tap started this, so play is allowed
  }

  function exit(silent) {
    if (!V.take) return;
    cancelAnimationFrame(V.raf);
    if (V.audio) { V.audio.pause(); V.audio.src = ''; }
    if (V.url) URL.revokeObjectURL(V.url);
    Object.assign(V, { take: null, audio: null, url: '' });
    document.body.classList.remove('reviewing');
    if (!silent && P.s) { updateUI(); pokeBar(); }
  }

  function toggle() {
    if (!V.audio) return;
    if (V.audio.paused) {
      if (V.audio.ended) V.audio.currentTime = 0;
      V.audio.play().catch(() => {});
    } else V.audio.pause();
    paintBar();
  }
  function skip(sec) {
    if (!V.audio) return;
    V.audio.currentTime = Math.max(0, Math.min((V.audio.duration || V.take.duration) - 0.1, V.audio.currentTime + sec));
    setPos(posAt(V.audio.currentTime));
  }
  function seekTo(t) {
    if (!V.audio) return;
    V.audio.currentTime = t;
    setPos(posAt(t));
  }
  /** Jump the recording to the first moment a section was at the reading line. */
  function seekSection(si) {
    if (!V.take) return false;
    const T = V.take.t;
    for (let j = 0; j < T.length; j++) {
      const i = P.keyIndex.get(V.take.keys[V.take.k[j]]);
      if (i != null && P.doc.items[i].sec === si) { seekTo(T[j]); return true; }
    }
    toast('That section isn’t in this recording.');
    return true;
  }
  function pauseAudio() { if (V.audio && !V.audio.paused) { V.audio.pause(); paintBar(); } }

  function setup() {
    $('#pb-play').addEventListener('click', toggle);
    $('#pb-back').addEventListener('click', () => skip(-15));
    $('#pb-fwd').addEventListener('click', () => skip(15));
    $('#pb-exit').addEventListener('click', () => exit());
    $('#pb-rate').addEventListener('click', () => {
      V.rate = (V.rate + 1) % V.rates.length;
      if (V.audio) V.audio.playbackRate = V.rates[V.rate];
      paintBar();
    });
    const seek = $('#pb-seek');
    seek.addEventListener('input', () => { V.dragging = true; seekTo(Number(seek.value)); });
    seek.addEventListener('change', () => { V.dragging = false; });
  }

  return { active, open, exit, toggle, skip, seekSection, pauseAudio, setup };
})();

/* ---------- recordings list (in the Notes panel) ---------- */
async function renderRecordings() {
  const box = $('#n-recs');
  if (!box || !P.s) return;
  let list = [];
  try { list = await Media.list(P.s.id); } catch {}
  box.innerHTML = '';
  if (!Rec.supported()) {
    box.appendChild(el('li', 'muted small', 'This browser can’t record audio.'));
    return;
  }
  if (!list.length) {
    box.appendChild(el('li', 'muted small', 'No recordings yet. Turn on “● Rec” in the control bar, then press Start.'));
    return;
  }
  for (const t of list) {
    const li = el('li', 'rec-item');
    const info = el('div', 'rec-info');
    info.append(el('b', '', fmtDate(t.date, true)), el('span', 'muted small', `${fmt(t.duration)} · ${fmtSize(t.size)}`));
    const play = el('button', 'btn small primary', '▶ Play');
    play.addEventListener('click', () => Review.open(t.id));
    const share = el('button', 'btn small', 'Share');
    share.addEventListener('click', () => shareTake(t));
    const del = el('button', 'btn small danger', 'Delete');
    del.addEventListener('click', async () => {
      const ok = await modal({ title: 'Delete this recording?', text: `${fmtDate(t.date, true)} · ${fmt(t.duration)}. This can’t be undone.`, buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, kind: 'danger confirm' }] });
      if (ok) { await Media.remove(t.id); renderRecordings(); toast('Recording deleted'); }
    });
    li.append(info, play, share, del);
    box.appendChild(li);
  }
  if (navigator.storage && navigator.storage.estimate) {
    const total = list.reduce((n, t) => n + (t.size || 0), 0);
    box.appendChild(el('li', 'muted small', `${list.length} recording${list.length > 1 ? 's' : ''} · ${fmtSize(total)} on this device`));
  }
}

async function shareTake(t) {
  const ext = /mp4|aac|m4a/.test(t.mime) ? 'm4a' : 'webm';
  const name = `${t.title} ${new Date(t.date).toISOString().slice(0, 10)}.${ext}`.replace(/[\\/:*?"<>|]/g, '');
  const file = new File([t.blob], name, { type: t.mime });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: t.title });
      return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const a = el('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
