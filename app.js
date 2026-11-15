/* Prompter — app logic.
   Sections:
   1. Helpers           5. Prompter: layout + scrolling
   2. Storage           6. Prompter: timers, flags, notes
   3. Library           7. Keyboard, routing, startup
   4. Add / replace                                          */
'use strict';

/* ============================================================
   1. HELPERS
   ============================================================ */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
function fmtDate(ts, withTime) {
  const d = new Date(ts);
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString(undefined, opts);
}
/** Accepts "25", "25:30", "1:05:00" → seconds */
function parseDuration(str) {
  const parts = String(str).trim().split(':').map((p) => p.trim());
  if (!parts.length || parts.some((p) => p === '' || isNaN(p))) return null;
  const n = parts.map(Number);
  let sec;
  if (n.length === 1) sec = n[0] * 60;
  else if (n.length === 2) sec = n[0] * 60 + n[1];
  else sec = n[0] * 3600 + n[1] * 60 + n[2];
  return sec > 0 ? Math.round(sec) : null;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/** Simple modal. buttons: [{label, kind:'primary'|'danger'|'', value}] → resolves value (or null) */
function modal({ title, text, body, buttons, stack, input }) {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modal-title').textContent = title || '';
    const b = $('#modal-body');
    b.innerHTML = '';
    if (text) b.appendChild(el('p', '', text));
    let inp;
    if (input) {
      inp = el('input');
      inp.type = input.type || 'text';
      inp.value = input.value ?? '';
      if (input.placeholder) inp.placeholder = input.placeholder;
      if (input.inputmode) inp.inputMode = input.inputmode;
      b.appendChild(inp);
    }
    if (body) b.appendChild(body);
    const a = $('#modal-actions');
    a.innerHTML = '';
    a.className = stack ? 'modal-stack' : 'actions';
    const close = (val) => {
      m.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      resolve(val);
    };
    for (const btn of buttons) {
      const e = el('button', 'btn ' + (btn.kind || ''), btn.label);
      e.addEventListener('click', () => close(input && btn.value === true ? inp.value : btn.value));
      a.appendChild(e);
    }
    const onKey = (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); close(null); }
      else if (ev.key === 'Enter' && input) { ev.preventDefault(); close(inp.value); }
    };
    document.addEventListener('keydown', onKey, true);
    m.onclick = (ev) => { if (ev.target === m) close(null); };
    m.hidden = false;
    if (inp) setTimeout(() => { inp.focus(); inp.select(); }, 30);
  });
}
const modalOpen = () => !$('#modal').hidden;

/* ============================================================
   2. STORAGE (localStorage, one key per script)
   ============================================================ */
const Store = {
  IDS: 'prompter.ids',
  key: (id) => 'prompter.s.' + id,
  ids() {
    try { return JSON.parse(localStorage.getItem(this.IDS) || '[]'); } catch { return []; }
  },
  get(id) {
    try { return JSON.parse(localStorage.getItem(this.key(id))); } catch { return null; }
  },
  all() {
    return this.ids().map((id) => this.get(id)).filter(Boolean);
  },
  save(s) {
    s.updatedAt = Date.now();
    try {
      localStorage.setItem(this.key(s.id), JSON.stringify(s));
      const ids = this.ids();
      if (!ids.includes(s.id)) { ids.push(s.id); localStorage.setItem(this.IDS, JSON.stringify(ids)); }
      return true;
    } catch (e) {
      toast('Could not save — this device’s storage is full.', 5000);
      return false;
    }
  },
  remove(id) {
    localStorage.removeItem(this.key(id));
    localStorage.setItem(this.IDS, JSON.stringify(this.ids().filter((x) => x !== id)));
  },
};

function newScript(title, source) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    title: title || 'Untitled script',
    source,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    target: 25 * 60,
    settings: { speed: 5, font: null, mirror: false, pos: 0 },
    flags: {},
    times: { total: 0, sections: {}, finished: false },
    runs: [],
  };
}

/* ============================================================
   3. LIBRARY
   ============================================================ */
function renderLibrary() {
  const list = $('#lib-list');
  list.innerHTML = '';
  const scripts = Store.all().sort((a, b) => b.createdAt - a.createdAt);
  $('#lib-empty').hidden = scripts.length > 0;
  updateBankButton();

  for (const s of scripts) {
    const card = el('div', 'card');
    const open = el('button', 'card-open');
    open.appendChild(el('span', 'card-title', s.title));
    const meta = el('span', 'card-meta');
    meta.appendChild(el('span', '', 'Added ' + fmtDate(s.createdAt)));
    const last = s.runs && s.runs[s.runs.length - 1];
    if (last) meta.appendChild(el('span', 'run', `Last run ${fmt(last.total)} · ${fmtDate(last.date)}`));
    else if (s.times && s.times.total > 0) meta.appendChild(el('span', 'run', `In progress ${fmt(s.times.total)}`));
    else meta.appendChild(el('span', '', 'No run-throughs yet'));
    meta.appendChild(el('span', '', 'Target ' + fmt(s.target)));
    const nflags = Object.keys(s.flags || {}).length;
    if (nflags) meta.appendChild(el('span', '', `${nflags} flag${nflags > 1 ? 's' : ''}`));
    if (s.drive) meta.appendChild(el('span', 'gdoc', s.drive.lastSync ? 'Google Doc · synced ' + fmtAgo(s.drive.lastSync) : 'Google Doc'));
    open.appendChild(meta);
    open.addEventListener('click', () => go('#/s/' + s.id));

    const more = el('button', 'card-more', '⋯');
    more.setAttribute('aria-label', 'Options for ' + s.title);
    more.addEventListener('click', () => scriptMenu(s.id));
    card.append(open, more);
    list.appendChild(card);
  }
}

async function scriptMenu(id) {
  const s = Store.get(id);
  if (!s) return;
  const choice = await modal({
    title: s.title,
    stack: true,
    buttons: [
      { label: 'Rename', value: 'rename' },
      { label: `Set target time (now ${fmt(s.target)})`, value: 'target' },
      { label: 'Replace text with a new version', value: 'replace' },
      ...(s.drive
        ? [{ label: 'Sync with Google Drive', value: 'sync' }, { label: 'Unlink from Google Doc', value: 'unlink' }]
        : [{ label: 'Link to a Google Doc', value: 'link' }]),
      { label: 'Delete script', value: 'delete', kind: 'danger' },
      { label: 'Cancel', value: null },
    ],
  });
  if (choice === 'rename') {
    const t = await modal({ title: 'Rename script', input: { value: s.title }, buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: true, kind: 'primary' }] });
    if (t && t.trim()) { s.title = t.trim(); Store.save(s); renderLibrary(); }
  } else if (choice === 'target') {
    const t = await modal({
      title: 'Target time', text: 'Minutes, or minutes:seconds (e.g. 25 or 24:30).',
      input: { value: String(Math.round(s.target / 60)), inputmode: 'decimal' },
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: true, kind: 'primary' }],
    });
    if (t != null) {
      const sec = parseDuration(t);
      if (sec) { s.target = sec; Store.save(s); renderLibrary(); toast('Target set to ' + fmt(sec)); }
      else toast('That didn’t look like a time. Try 25 or 24:30.');
    }
  } else if (choice === 'replace') {
    go('#/replace/' + id);
  } else if (choice === 'sync') {
    syncTap([id]);
  } else if (choice === 'unlink') {
    delete s.drive; Store.save(s); renderLibrary(); toast('Unlinked. The script stays in Prompter.');
  } else if (choice === 'link') {
    linkTap(id);
  } else if (choice === 'delete') {
    const ok = await modal({ title: 'Delete “' + s.title + '”?', text: 'This removes the script, its flags and its run history from this device. It can’t be undone.', buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, kind: 'danger confirm' }] });
    if (ok) { Store.remove(id); renderLibrary(); toast('Deleted'); }
  }
}

function exportBackup() {
  const data = { app: 'Prompter', version: 1, exportedAt: Date.now(), scripts: Store.all() };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'prompter-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.scripts)) throw new Error();
    let n = 0;
    for (const s of data.scripts) if (s && s.id && typeof s.source === 'string') { Store.save(s); n++; }
    renderLibrary();
    toast(`Restored ${n} script${n === 1 ? '' : 's'}`);
  } catch {
    toast('That file isn’t a Prompter backup.');
  }
}

/* ============================================================
   4. ADD / REPLACE
   ============================================================ */
let addMode = { replaceId: null };

function showAdd(replaceId) {
  addMode = { replaceId, drive: null };
  const s = replaceId && Store.get(replaceId);
  $('#add-heading').textContent = s ? 'Replace text' : 'Add a script';
  $('#title-row').hidden = !!s;
  $('#add-title').value = '';
  $('#add-text').value = '';
  $('#add-save').textContent = s ? 'Replace text' : 'Save script';
  if (s) $('#add-heading').textContent = 'New version of “' + s.title + '”';
}

const scriptLoads = {};
function loadScript(src, what) {
  scriptLoads[src] = scriptLoads[src] || new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = src;
    sc.onload = res;
    sc.onerror = () => { delete scriptLoads[src]; rej(new Error('Could not load the ' + what)); };
    document.head.appendChild(sc);
  });
  return scriptLoads[src];
}

async function loadWordReader() {
  if (!window.mammoth) await loadScript('lib/mammoth.browser.min.js', 'Word reader');
  if (!window.JSZip) await loadScript('lib/jszip.min.js', 'Word reader').catch(() => {});
}

async function readFile(file) {
  const name = file.name || 'Script';
  const ext = (name.split('.').pop() || '').toLowerCase();
  let text;
  if (ext === 'docx') {
    toast('Reading Word file…');
    await loadWordReader();
    text = await Parser.docxToText(await file.arrayBuffer());
  } else if (ext === 'pdf' || file.type === 'application/pdf') {
    toast('Reading PDF…');
    if (!window.pdfjsLib) await loadScript('lib/pdf.min.js', 'PDF reader');
    text = await Parser.pdfToText(await file.arrayBuffer());
  } else if (ext === 'doc') {
    throw new Error('Old .doc files aren’t supported. In Word, use File → Save As → .docx.');
  } else {
    text = await file.text();
  }
  return { title: name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim(), text };
}

async function handleAddFile(file) {
  if (!file) return;
  try {
    const { title, text } = await readFile(file);
    addMode.drive = null;
    fillAddText(file.name, title, text);
  } catch (e) {
    toast(e.message || 'Could not read that file.', 5000);
  }
}

/** Put imported text in the add screen and say what was found. */
function fillAddText(label, title, text) {
  $('#add-text').value = text;
  if (!$('#add-title').value.trim()) $('#add-title').value = title;
  const parts = Parser.splitParts(text);
  if (parts.length > 1 && !addMode.replaceId) {
    toast(`Loaded “${label}” — ${parts.length} parts separated by section breaks. Tap Save to make each one its own script.`, 5000);
  } else {
    const n = Parser.parse(text).sections.length;
    toast(`Loaded “${label}” — ${n} section${n === 1 ? '' : 's'} found. Check it, then save.`, 3500);
  }
}

/** "From Google Drive" on the add screen. Must start straight from the tap (sign-in window). */
function addFromDrive() {
  GDrive.withToken()
    .then(() => GDrive.pick())
    .then(async (f) => {
      if (!f) return;
      toast('Reading “' + f.name + '” from Google Drive…', 6000);
      const m = await GDrive.meta(f.id);
      const text = await GDrive.readText(m, loadWordReader);
      addMode.drive = { id: m.id, name: m.name, mimeType: m.mimeType, modifiedTime: m.modifiedTime, link: m.webViewLink };
      fillAddText(m.name, m.name, text);
    })
    .catch((e) => toast(e.message || 'Couldn’t open Google Drive.', 5000));
}

/** Swap in new script text, keeping flags whose lines are unchanged. */
function applyNewText(s, text) {
  const keys = new Set(Parser.parse(text).items.map((i) => i.key));
  const before = Object.keys(s.flags || {});
  const kept = {}, dropped = [];
  for (const k of before) {
    if (keys.has(k)) kept[k] = s.flags[k];
    else dropped.push({ text: k.split('|').slice(1).join('|'), note: flagSummary(s.flags[k]) });
  }
  s.flags = kept;
  s.source = text;
  if (s.settings) s.settings.pos = 0;
  return { kept: Object.keys(kept).length, total: before.length, dropped };
}

async function saveAdd() {
  let text = $('#add-text').value;
  if (!text.trim()) { toast('Add some script text first.'); return; }
  const parts = Parser.splitParts(text);
  if (parts.length > 1 && addMode.replaceId) {
    text = parts.join('\n\n'); // a replacement is one script; drop the break lines
  } else if (parts.length > 1) {
    const list = el('ol', 'part-list');
    parts.forEach((pt) => list.appendChild(el('li', '', Parser.partTitle(pt))));
    const choice = await modal({
      title: `Split into ${parts.length} scripts?`,
      text: 'This has section breaks. Each part can be saved as its own script:',
      body: list,
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Keep as one', value: 'one' },
        { label: `Save ${parts.length} scripts`, value: 'split', kind: 'primary' },
      ],
    });
    if (!choice) return;
    if (choice === 'split') {
      const now = Date.now();
      let ok = true;
      parts.forEach((pt, i) => {
        const sc = newScript(Parser.partTitle(pt), pt);
        sc.createdAt = now - i; // keeps document order at the top of the newest-first list
        if (addMode.drive) sc.drive = { ...addMode.drive, part: i, partTitle: Parser.partTitle(pt) };
        ok = Store.save(sc) && ok;
      });
      if (ok) { toast(`Saved ${parts.length} scripts`); go('#/'); }
      return;
    }
    text = parts.join('\n\n');
  }
  if (addMode.replaceId) {
    const s = Store.get(addMode.replaceId);
    if (!s) return go('#/');
    const r = applyNewText(s, text);
    if (addMode.drive) s.drive = { ...addMode.drive, part: null };
    Store.save(s);
    toast(r.total ? `Text replaced. Kept ${r.kept} of ${r.total} flags${r.dropped.length ? ' (the other lines changed)' : ''}.` : 'Text replaced.', 4500);
    go('#/');
  } else {
    let title = $('#add-title').value.trim();
    if (!title) {
      const p = Parser.parse(text);
      title = (p.items[0] && p.items[0].text.slice(0, 60)) || 'Untitled script';
    }
    const s = newScript(title, text);
    if (addMode.drive) s.drive = { ...addMode.drive, part: null };
    if (Store.save(s)) { toast('Saved “' + title + '”'); go('#/'); }
  }
}

/* ============================================================
   4b. GOOGLE DRIVE SYNC
   ============================================================ */
function fmtAgo(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + ' hr ago';
  return fmtDate(ts);
}

function driveNotesText(s) {
  const d = s.drive;
  const lines = [];
  lines.push(`${s.title} — Prompter notes`);
  lines.push(`Script doc: ${d.name}${d.part != null ? ` (the part titled “${d.partTitle}”)` : ''}`);
  if (d.link) lines.push(d.link);
  lines.push(`Last synced from Prompter: ${fmtDate(Date.now(), true)}`);
  lines.push('');
  lines.push('For Claude: these flags come from practice run-throughs in my teleprompter. Each quotes a line exactly as it appears in the script doc. Please make the edits in the script doc itself, keep the # headings, [stage cues] and [Slide N] cues unless a note says otherwise, and tell me what you changed.');
  lines.push('');
  lines.push(notesTextFor(s));
  const runs = (s.runs || []).slice(-5).reverse();
  if (runs.length) {
    lines.push('');
    lines.push('Recent run-throughs:');
    for (const r of runs) lines.push(`- ${fmtDate(r.date, true)}: ${fmt(r.total)}`);
  }
  if (d.resolved && d.resolved.flags.length) {
    lines.push('');
    lines.push(`Lines that changed in the doc since they were flagged (probably already handled, ${fmtDate(d.resolved.at, true)}):`);
    for (const f of d.resolved.flags) lines.push(`- "${f.text}"${f.note ? ' — ' + f.note : ''}`);
  }
  return lines.join('\n');
}

/** Pull the doc into the script if it changed, then write the notes doc. Needs a sign-in token. */
async function syncScript(s) {
  const d = s.drive;
  let m;
  try { m = await GDrive.meta(d.id); } catch (e) {
    if (e.status === 404) throw new Error(`“${d.name}” isn’t available in Google Drive any more.`);
    throw e;
  }
  if (m.trashed) throw new Error(`“${m.name}” is in the Google Drive trash.`);
  let changed = false, dropped = [];
  if (m.modifiedTime !== d.modifiedTime) {
    let text = await GDrive.readText(m, loadWordReader);
    const parts = Parser.splitParts(text);
    if (d.part != null) {
      let idx = parts.findIndex((p) => Parser.partTitle(p) === d.partTitle);
      if (idx < 0 && d.part < parts.length) idx = d.part;
      if (idx < 0) throw new Error(`Couldn’t find the part “${d.partTitle}” in “${m.name}”.`);
      text = parts[idx];
      d.part = idx;
      d.partTitle = Parser.partTitle(text);
    } else {
      text = parts.join('\n\n');
    }
    if (Parser.norm(text) !== Parser.norm(s.source)) {
      const r = applyNewText(s, text);
      dropped = r.dropped;
      changed = true;
      d.resolved = { at: Date.now(), flags: dropped };
    }
    d.modifiedTime = m.modifiedTime;
    d.name = m.name;
    d.link = m.webViewLink;
  }
  d.notesId = await GDrive.writeNotes(d.notesId, `${s.title} — Prompter notes`, driveNotesText(s));
  d.lastSync = Date.now();
  Store.save(s);
  return { changed, dropped };
}

/** Sync one or more scripts. Call straight from a tap (Google sign-in needs it). */
function syncTap(ids, after) {
  if (P.s) saveNow();
  GDrive.withToken()
    .then(async () => {
      const list = ids.map((id) => Store.get(id)).filter((s) => s && s.drive);
      if (!list.length) { toast('No scripts are linked to Google Docs yet.'); return; }
      toast(`Syncing ${list.length > 1 ? list.length + ' scripts' : '“' + list[0].title + '”'}…`, 20000);
      let updated = 0, cleared = 0;
      const errors = [];
      for (const s of list) {
        try {
          const r = await syncScript(s);
          if (r.changed) { updated++; cleared += r.dropped.length; }
        } catch (e) { errors.push(`${s.title}: ${e.message}`); }
      }
      const done = list.length - errors.length;
      let msg = done ? `Synced${list.length > 1 ? ' ' + done + ' scripts' : ''}. ` : '';
      msg += updated ? `${updated} updated from Google Docs${cleared ? `, ${cleared} flag${cleared > 1 ? 's' : ''} on changed lines cleared` : ''}. Notes saved to Drive.` : (done ? 'No changes in the doc; notes saved to Drive.' : '');
      if (errors.length) msg += ' ' + errors.join(' ');
      toast(msg.trim(), errors.length ? 9000 : 5000);
      if (P.s && ids.includes(P.s.id)) {
        openPrompter(P.s.id);
        if (!$('#panel-notes').hidden) renderNotes();
      }
      if (after) after();
      if (!$('#view-library').hidden) renderLibrary();
    })
    .catch((e) => toast(e.message || 'Sync failed.', 6000));
}

/** Link an existing script to a Google Doc, then sync (the doc becomes the source of the text). */
function linkTap(id) {
  GDrive.withToken()
    .then(() => GDrive.pick())
    .then(async (f) => {
      if (!f) return;
      const s = Store.get(id);
      const ok = await modal({
        title: 'Link to “' + f.name + '”?',
        text: 'From now on, Sync replaces this script’s text with the Google Doc’s text (flags on unchanged lines are kept), and saves your notes to Drive.',
        buttons: [{ label: 'Cancel', value: false }, { label: 'Link and sync', value: true, kind: 'primary' }],
      });
      if (!ok) return;
      s.drive = { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: null, part: null };
      Store.save(s);
      const r = await syncScript(s);
      toast(`Linked to “${f.name}”${r.changed ? ' and updated from the doc' : ''}. Notes saved to Drive.`, 5000);
      renderLibrary();
    })
    .catch((e) => toast(e.message || 'Couldn’t link to Google Drive.', 6000));
}

/* ============================================================
   5. PROMPTER — layout + scrolling
   ============================================================ */
const CHIPS = ['Cut this', 'Reword', 'I keep tripping here', 'Too long', 'Need to memorize', 'Slide is wrong'];

const P = {
  s: null,          // script object
  doc: null,        // parsed { sections, items }
  itemEls: [],
  markers: [],      // [{ sec, top }]
  playing: false,
  started: false,
  pos: 0,
  maxPos: 0,
  readY: 0,
  curSec: 0,
  lastTs: 0,
  raf: 0,
  dirty: false,
  lastSave: 0,
  wake: null,
  flagItem: null,
};
const stage = () => $('#stage');
const content = () => $('#content');

function defaultFont() {
  const w = window.innerWidth, h = window.innerHeight;
  return Math.round(clamp(Math.min(w * 0.045, h * 0.075), 28, 72));
}

function openPrompter(id) {
  const s = Store.get(id);
  if (!s) { go('#/'); return; }
  // fill in fields that older saves may lack
  s.settings = Object.assign({ speed: 5, font: null, mirror: false, pos: 0 }, s.settings);
  s.times = Object.assign({ total: 0, sections: {}, finished: false }, s.times);
  s.flags = s.flags || {};
  s.runs = s.runs || [];
  if (!s.settings.font) s.settings.font = defaultFont();

  P.s = s;
  P.doc = Parser.parse(s.source);
  P.markers = [];
  P.curSec = -1;
  P.playing = false;
  P.started = false;
  P.pos = s.settings.pos || 0;
  renderContent();
  stage().classList.toggle('mirror', !!s.settings.mirror);
  $('#b-mirror').setAttribute('aria-pressed', String(!!s.settings.mirror));
  layout(false);
  updateUI();
  updateTimers(true);
  updateFlagCount();
  $('#hint').hidden = s.times.total > 0;
  pokeBar();
}

function renderContent() {
  const c = content();
  c.innerHTML = '';
  P.itemEls = [];
  const frag = document.createDocumentFragment();
  P.doc.sections.forEach((sec, si) => {
    const mk = el('div', 'sec-mark');
    mk.dataset.sec = si;
    frag.appendChild(mk);
    for (const it of sec.items) {
      const e = renderItem(it);
      P.itemEls[it.i] = e;
      frag.appendChild(e);
    }
  });
  if (!P.doc.items.length) frag.appendChild(el('div', 'item cue', '[This script is empty]'));
  frag.appendChild(el('div', 'end-mark', '— End —'));
  c.appendChild(frag);
}

function renderItem(it) {
  const cls = ['item', it.type];
  if (it.type === 'h') cls.push('h' + it.level);
  const e = el('div', cls.join(' '));
  e.dataset.i = it.i;
  const t = el('span', 't');
  for (const tok of Parser.tokens(it.text)) {
    if (tok.kind === 'text') t.appendChild(document.createTextNode(tok.text));
    else if (tok.kind === 'cue') t.appendChild(el('span', 'cue-s', tok.text));
    else {
      t.appendChild(el('span', 'slide-chip', '▶ Slide ' + tok.num));
      if (tok.rest) t.appendChild(el('span', 'slide-rest', tok.rest));
    }
  }
  e.appendChild(t);
  applyFlagToEl(it, e);
  return e;
}

function flagSummary(f) {
  if (!f) return '';
  const parts = [];
  if (f.chips && f.chips.length) parts.push(f.chips.join('; '));
  if (f.note && f.note.trim()) parts.push(f.note.trim());
  return parts.join(' — ');
}

function applyFlagToEl(it, e) {
  const f = P.s.flags[it.key];
  e.classList.toggle('flagged', !!f);
  const old = e.querySelector('.flag-note');
  if (old) old.remove();
  if (f) {
    const txt = flagSummary(f) || 'Flagged';
    e.appendChild(el('div', 'flag-note', txt));
  }
}

/** Measure everything. keepAnchor: keep the same text at the reading line. */
function layout(keepAnchor = true) {
  const st = stage(), c = content();
  let anchor = null;
  if (keepAnchor && P.markers.length) anchor = anchorAt();

  const H = st.clientHeight;
  P.readY = Math.round(H * 0.35);
  const fs = P.s.settings.font;
  c.style.fontSize = fs + 'px';
  c.style.paddingTop = Math.max(0, P.readY - fs * 0.72) + 'px';
  c.style.paddingBottom = (H - P.readY + fs) + 'px';

  P.markers = [...c.querySelectorAll('.sec-mark')].map((m) => ({ sec: +m.dataset.sec, top: m.offsetTop }));
  P.maxPos = Math.max(0, c.scrollHeight - H);

  if (anchor) {
    const e = P.itemEls[anchor.i];
    if (e) P.pos = e.offsetTop + anchor.frac * e.offsetHeight - P.readY;
  }
  setPos(P.pos);
}

function anchorAt() {
  const y = P.pos + P.readY;
  for (const e of P.itemEls) {
    if (!e) continue;
    if (e.offsetTop + e.offsetHeight >= y) {
      return { i: +e.dataset.i, frac: clamp((y - e.offsetTop) / Math.max(1, e.offsetHeight), 0, 1) };
    }
  }
  return null;
}

function setPos(p) {
  P.pos = clamp(p, 0, P.maxPos);
  content().style.transform = `translate3d(0, ${-P.pos}px, 0)`;
  const sec = sectionAt(P.pos);
  if (sec !== P.curSec) { P.curSec = sec; updateTimers(true); }
}

function sectionAt(pos) {
  const y = pos + P.readY + P.s.settings.font * 0.6;
  let cur = 0;
  for (const m of P.markers) { if (m.top <= y) cur = m.sec; else break; }
  return cur;
}

function pxPerSec() {
  return P.s.settings.speed * P.s.settings.font * 0.1;
}

function frame(ts) {
  if (!P.playing) return;
  const dt = P.lastTs ? Math.min((ts - P.lastTs) / 1000, 1) : 0;
  P.lastTs = ts;
  if (dt > 0) {
    addTime(dt);
    setPos(P.pos + pxPerSec() * dt);
    if (P.pos >= P.maxPos - 0.5) { reachedEnd(); return; }
  }
  P.raf = requestAnimationFrame(frame);
}

function play() {
  if (P.playing || !P.s) return;
  if (P.s.times.finished) {
    // last run was finished and saved — start a fresh run
    resetTimes(true);
    if (P.pos >= P.maxPos - 2) setPos(0);
    toast('New run-through started');
  } else if (P.pos >= P.maxPos - 2) {
    setPos(0);
  }
  P.playing = true;
  P.started = true;
  P.lastTs = 0;
  $('#hint').hidden = true;
  closeAllPanels();
  updateUI();
  wakeOn();
  pokeBar();
  P.raf = requestAnimationFrame(frame);
}

function pause() {
  if (!P.playing) return;
  P.playing = false;
  cancelAnimationFrame(P.raf);
  wakeOff();
  updateUI();
  saveNow();
  pokeBar();
}
const toggle = () => (P.playing ? pause() : play());

function reachedEnd() {
  pause();
  if (P.s.times.total >= 5) {
    saveRun();
    toast(`End of script — run saved (${fmt(P.s.times.total)})`, 4000);
  }
}

function updateUI() {
  const b = $('#b-play');
  const finished = P.s && P.s.times.finished;
  b.textContent = P.playing ? '❚❚ Pause' : (finished ? '↺ Restart' : (P.started || (P.s && P.s.times.total > 0) ? '▶ Resume' : '▶ Start'));
  b.setAttribute('aria-label', P.playing ? 'Pause' : 'Start');
  $('#paused-pill').hidden = P.playing || !(P.started || (P.s && P.s.times.total > 0));
  $('#v-speed').textContent = P.s ? P.s.settings.speed : '';
}

/* wake lock */
async function wakeOn() {
  try {
    if ('wakeLock' in navigator && !P.wake) {
      P.wake = await navigator.wakeLock.request('screen');
      P.wake.addEventListener('release', () => { P.wake = null; });
    }
  } catch { /* not supported or refused — fine */ }
}
function wakeOff() {
  if (P.wake) { P.wake.release().catch(() => {}); P.wake = null; }
}

/* control bar fade */
let barTimer;
function pokeBar() {
  const bar = $('#bar');
  bar.classList.remove('faded');
  clearTimeout(barTimer);
  if (P.playing) barTimer = setTimeout(() => bar.classList.add('faded'), 2500);
}

/* settings */
function changeSpeed(d) {
  P.s.settings.speed = clamp(P.s.settings.speed + d, 1, 30);
  updateUI(); saveSettingsSoon(); pokeBar();
}
function changeFont(d) {
  P.s.settings.font = clamp(P.s.settings.font + d, 18, 140);
  layout(true); saveSettingsSoon(); pokeBar();
  toast('Text size ' + P.s.settings.font, 900);
}
function toggleMirror() {
  P.s.settings.mirror = !P.s.settings.mirror;
  stage().classList.toggle('mirror', P.s.settings.mirror);
  $('#b-mirror').setAttribute('aria-pressed', String(P.s.settings.mirror));
  saveSettingsSoon(); pokeBar();
}
function nudge(dir) {
  setPos(P.pos + dir * stage().clientHeight * 0.25);
  P.dirty = true;
  pokeBar();
}

/* ============================================================
   6. PROMPTER — timers, flags, notes
   ============================================================ */
function addTime(dt) {
  const t = P.s.times;
  t.total += dt;
  P.s.practicedAt = Date.now();
  const key = P.doc.sections[P.curSec] ? P.doc.sections[P.curSec].key : null;
  if (key) t.sections[key] = (t.sections[key] || 0) + dt;
  P.dirty = true;
  updateTimers(false);
  const now = performance.now();
  if (now - P.lastSave > 3000) { P.lastSave = now; saveNow(); }
}

let lastShown = '';
function updateTimers(force) {
  if (!P.s) return;
  const t = P.s.times;
  const sec = P.doc.sections[P.curSec];
  const secTime = sec ? t.sections[sec.key] || 0 : 0;
  const sig = Math.floor(t.total) + '|' + Math.floor(secTime) + '|' + P.curSec;
  if (!force && sig === lastShown) return;
  lastShown = sig;
  const tot = $('#t-total');
  tot.textContent = `${fmt(t.total)} / ${fmt(P.s.target)}`;
  tot.classList.toggle('over', t.total > P.s.target);
  $('#t-sec').textContent = fmt(secTime);
  $('#t-secname').textContent = sec ? sec.title : 'Section';
}

function saveNow() {
  if (!P.s) return;
  P.s.settings.pos = P.pos;
  Store.save(P.s);
  P.dirty = false;
}
let settingsTimer;
function saveSettingsSoon() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(saveNow, 400);
}

function resetTimes(silent) {
  P.s.times = { total: 0, sections: {}, finished: false };
  saveNow();
  updateTimers(true);
  updateUI();
  if (!silent) { toast('Times reset'); renderNotes(); }
}

function sectionTimesList() {
  return P.doc.sections.map((s) => ({ title: s.title, sec: P.s.times.sections[s.key] || 0 }));
}

function saveRun() {
  const t = P.s.times;
  if (t.total < 1) { toast('Nothing to save yet — start the prompter first.'); return; }
  P.s.runs.push({ date: Date.now(), total: Math.round(t.total), target: P.s.target, sections: sectionTimesList().map((x) => ({ title: x.title, sec: Math.round(x.sec) })) });
  t.finished = true;
  saveNow();
  updateUI();
}

/* --- flags --- */
function updateFlagCount() {
  const n = Object.keys(P.s.flags).length;
  const b = $('#flag-count');
  b.textContent = n;
  b.hidden = n === 0;
}

function openFlag(i) {
  const it = P.doc.items[i];
  if (!it) return;
  pause();
  P.flagItem = it;
  const f = P.s.flags[it.key];
  $('#flag-title').textContent = f ? 'Edit flag' : 'Flag this line';
  $('#flag-line').textContent = it.raw;
  const chips = $('#flag-chips');
  chips.innerHTML = '';
  for (const c of CHIPS) {
    const b = el('button', 'chip', c);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(!!(f && f.chips && f.chips.includes(c))));
    b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')));
    chips.appendChild(b);
  }
  $('#flag-note').value = f ? f.note || '' : '';
  $('#flag-remove').hidden = !f;
  showPanel('#sheet-flag');
  P.flagItem = it; // set after showPanel, which clears it
}

function saveFlag() {
  const it = P.flagItem;
  if (!it) return;
  const chips = [...document.querySelectorAll('#flag-chips .chip')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
  P.s.flags[it.key] = { chips, note: $('#flag-note').value.trim(), at: Date.now() };
  finishFlagEdit(it);
}
function removeFlag() {
  const it = P.flagItem;
  if (!it) return;
  delete P.s.flags[it.key];
  finishFlagEdit(it);
}
function finishFlagEdit(it) {
  applyFlagToEl(it, P.itemEls[it.i]);
  saveNow();
  updateFlagCount();
  closeAllPanels();
  layout(true);
}

function jumpToItem(i) {
  const e = P.itemEls[i];
  if (!e) return;
  setPos(e.offsetTop - P.readY + P.s.settings.font * 0.7);
  saveSettingsSoon();
}
function jumpToSection(si) {
  const m = P.markers.find((x) => x.sec === si);
  if (!m) return;
  setPos(m.top - P.readY + P.s.settings.font * 0.4);
  saveSettingsSoon();
}

/* --- panels --- */
function showPanel(sel) {
  closeAllPanels();
  pause();
  $('#scrim').hidden = false;
  $(sel).hidden = false;
  $('#bar').classList.remove('faded');
}
function closeAllPanels() {
  const a = document.activeElement;
  if (a && a.closest && a.closest('.panel, .sheet')) a.blur();
  ['#panel-jump', '#panel-notes', '#sheet-flag'].forEach((s) => ($(s).hidden = true));
  $('#scrim').hidden = true;
  $('#copy-fallback').hidden = true;
  P.flagItem = null;
}
const anyPanelOpen = () => ['#panel-jump', '#panel-notes', '#sheet-flag'].some((s) => !$(s).hidden);

function openJump() {
  const list = $('#jump-list');
  list.innerHTML = '';
  P.doc.sections.forEach((s, si) => {
    const b = el('button', 'jump-item' + (si === P.curSec ? ' current' : ''));
    b.append(el('span', 'jn', si + 1 + '.'), el('span', 'jt', s.title), el('span', 'jtime', fmt(P.s.times.sections[s.key] || 0)));
    b.addEventListener('click', () => { jumpToSection(si); closeAllPanels(); });
    list.appendChild(b);
  });
  showPanel('#panel-jump');
  const cur = list.querySelector('.current');
  if (cur) cur.scrollIntoView({ block: 'center' });
}

function orderedFlags() {
  return P.doc.items.filter((it) => P.s.flags[it.key]).map((it) => ({ it, f: P.s.flags[it.key] }));
}

function renderNotes() {
  // times table
  const tb = $('#n-times');
  tb.innerHTML = '';
  sectionTimesList().forEach((x, si) => {
    const tr = el('tr', si === P.curSec ? 'current' : '');
    tr.append(el('td', '', x.title), el('td', '', fmt(x.sec)));
    tb.appendChild(tr);
  });
  const t = P.s.times.total;
  const tr = el('tr', 'total' + (t > P.s.target ? ' over' : ''));
  tr.append(el('td', '', 'Total (target ' + fmt(P.s.target) + ')'), el('td', '', fmt(t)));
  tb.appendChild(tr);

  // flags
  const list = $('#n-flags');
  list.innerHTML = '';
  const flags = orderedFlags();
  for (const { it, f } of flags) {
    const li = el('li');
    li.appendChild(el('span', 'fl-sec', P.doc.sections[it.sec].title));
    li.appendChild(el('span', 'fl-text', '“' + Parser.plainText(it) + '”'));
    const sum = flagSummary(f);
    if (sum) li.appendChild(el('span', 'fl-note', sum));
    li.addEventListener('click', () => { closeAllPanels(); jumpToItem(it.i); });
    list.appendChild(li);
  }
  $('#n-noflags').hidden = flags.length > 0;
  $('#n-flagcount').textContent = flags.length ? `(${flags.length})` : '';
  resetClearBtn();

  // Google Drive
  const d = P.s.drive;
  $('#n-drive').hidden = !d;
  if (d) $('#n-drive-info').textContent = `Linked to “${d.name}”` + (d.lastSync ? ` · synced ${fmtAgo(d.lastSync)}` : ' · not synced yet');

  // save-run button
  const sr = $('#n-saverun');
  sr.disabled = P.s.times.total < 1 || P.s.times.finished;
  sr.textContent = P.s.times.finished ? 'This run is saved ✓' : 'Finish & save this run';

  // run history (newest first) with change vs the previous run
  const runs = $('#n-runs');
  runs.innerHTML = '';
  if (!P.s.runs.length) runs.appendChild(el('li', 'muted', 'No saved runs yet. A run saves when you reach the end, or with “Finish & save this run”.'));
  const rs = P.s.runs.map((r, idx) => ({ r, prev: P.s.runs[idx - 1] })).reverse();
  for (const { r, prev } of rs) {
    const li = el('li');
    li.appendChild(el('span', 'rd', fmtDate(r.date, true)));
    if (prev) {
      const d = r.total - prev.total;
      li.appendChild(el('span', 'delta ' + (d < 0 ? 'faster' : d > 0 ? 'slower' : ''), (d < 0 ? '−' : d > 0 ? '+' : '±') + fmt(Math.abs(d))));
    }
    li.appendChild(el('b', '', fmt(r.total)));
    runs.appendChild(li);
  }
}

function openNotes() {
  renderNotes();
  showPanel('#panel-notes');
}

/** Plain-text run-through notes for any script (doc = its parsed text). */
function notesTextFor(s, doc) {
  doc = doc || Parser.parse(s.source);
  const times = (s.times && s.times.sections) || {};
  const flags = s.flags || {};
  const lines = [];
  lines.push(`${s.title}: run-through notes`);
  lines.push(`Total time: ${fmt(s.times ? s.times.total : 0)} (target ${fmt(s.target)})`);
  lines.push('Section times:');
  for (const sec of doc.sections) lines.push(`- ${sec.title}: ${fmt(times[sec.key] || 0)}`);
  const flagged = doc.items.filter((it) => flags[it.key]);
  lines.push('Flags:' + (flagged.length ? '' : ' none'));
  flagged.forEach((it, n) => {
    lines.push(`${n + 1}. [${doc.sections[it.sec].title}] "${Parser.plainText(it)}"`);
    const sum = flagSummary(flags[it.key]);
    if (sum) lines.push(`   Note: ${sum}`);
  });
  return lines.join('\n');
}
const notesText = () => notesTextFor(P.s, P.doc);

/** Copy text; if the clipboard is blocked, show it selected in `box` so it can be copied by hand. */
async function copyText(text, box, wrap) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; }
  } catch { ok = false; }
  if (!ok) {
    box.value = text;
    if (wrap) wrap.hidden = false;
    box.focus();
    box.select();
    box.setSelectionRange(0, text.length);
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    if (ok && wrap) wrap.hidden = true;
    if (!ok) toast('Copying was blocked — the text is selected, press and hold to copy it.', 4000);
  }
  return ok;
}

async function copyNotes() {
  if (await copyText(notesText(), $('#copy-box'), $('#copy-fallback'))) toast('Notes copied — paste them into Claude');
}

/* --- notes bank: every script's notes in one place --- */
function bankScripts() {
  return Store.all()
    .filter((s) => Object.keys(s.flags || {}).length || (s.times && s.times.total >= 1))
    .sort((a, b) => (a.practicedAt || a.updatedAt) - (b.practicedAt || b.updatedAt));
}
function bankText(list) {
  if (!list.length) return '';
  const head = list.length > 1 ? `Prompter notes for ${list.length} scripts\n\n` : '';
  return head + list.map((s) => notesTextFor(s)).join('\n\n----------\n\n');
}
function renderBank() {
  const list = bankScripts();
  const nflags = list.reduce((n, s) => n + Object.keys(s.flags || {}).length, 0);
  $('#bank-summary').textContent = list.length
    ? `${list.length} script${list.length > 1 ? 's' : ''} · ${nflags} flag${nflags === 1 ? '' : 's'}`
    : 'No notes yet. Run through a script and flag lines, and they’ll collect here.';
  $('#bank-text').value = bankText(list);
  $('#bank-text').hidden = !list.length;
  $('#bank-copy').disabled = !list.length;
  $('#bank-clear').disabled = !list.length;
  const linked = Store.all().filter((s) => s.drive).length;
  $('#bank-sync').hidden = !linked;
  $('#bank-sync').textContent = `Sync ${linked} Google Doc${linked === 1 ? '' : 's'}`;
  resetBankClear();
}
let bankArmed = false, bankTimer;
function resetBankClear() {
  bankArmed = false;
  clearTimeout(bankTimer);
  const b = $('#bank-clear');
  b.textContent = 'Clear all';
  b.classList.remove('confirm');
}
function clearBank() {
  const list = bankScripts();
  if (!list.length) return;
  if (!bankArmed) {
    bankArmed = true;
    const b = $('#bank-clear');
    b.textContent = `Tap again to clear ${list.length} script${list.length > 1 ? 's' : ''}`;
    b.classList.add('confirm');
    bankTimer = setTimeout(resetBankClear, 4000);
    return;
  }
  for (const s of list) {
    const t = s.times || { total: 0, sections: {} };
    if (t.total >= 5 && !t.finished) {
      const doc = Parser.parse(s.source);
      s.runs = s.runs || [];
      s.runs.push({ date: Date.now(), total: Math.round(t.total), target: s.target, sections: doc.sections.map((x) => ({ title: x.title, sec: Math.round(t.sections[x.key] || 0) })) });
    }
    s.flags = {};
    s.times = { total: 0, sections: {}, finished: false };
    Store.save(s);
  }
  renderBank();
  toast('Cleared — run times were saved to each script’s history');
}
function updateBankButton() {
  const n = bankScripts().length;
  const b = $('#bank-count');
  b.textContent = n;
  b.hidden = !n;
}

let clearArmed = false, clearTimer;
function resetClearBtn() {
  clearArmed = false;
  clearTimeout(clearTimer);
  const b = $('#n-clear');
  b.textContent = 'Clear flags';
  b.classList.remove('confirm');
}
function clearFlags() {
  const n = Object.keys(P.s.flags).length;
  if (!n) { toast('No flags to clear'); return; }
  if (!clearArmed) {
    clearArmed = true;
    const b = $('#n-clear');
    b.textContent = `Tap again to clear ${n} flag${n > 1 ? 's' : ''}`;
    b.classList.add('confirm');
    clearTimer = setTimeout(resetClearBtn, 4000);
    return;
  }
  P.s.flags = {};
  P.itemEls.forEach((e, i) => e && applyFlagToEl(P.doc.items[i], e));
  saveNow();
  updateFlagCount();
  layout(true);
  renderNotes();
  toast('Flags cleared');
}

/* --- stage pointer handling: drag to scroll, tap line to flag, tap space to play/pause --- */
function setupStage() {
  const st = stage();
  let down = null;
  st.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    down = { x: e.clientX, y: e.clientY, pos: P.pos, moved: false, id: e.pointerId, target: e.target };
  });
  st.addEventListener('pointermove', (e) => {
    if (!down || e.pointerId !== down.id) return;
    const dy = e.clientY - down.y;
    if (!down.moved && Math.abs(dy) > 8) {
      down.moved = true;
      try { st.setPointerCapture(e.pointerId); } catch {}
    }
    if (down.moved) { setPos(down.pos - dy); P.dirty = true; }
  });
  const end = (e) => {
    if (!down || e.pointerId !== down.id) return;
    const d = down;
    down = null;
    if (d.moved) { saveSettingsSoon(); return; }
    if (e.type === 'pointercancel') return;
    const t = d.target.closest && d.target.closest('.item');
    const onText = d.target.closest && d.target.closest('.t, .flag-note');
    if (t && onText) openFlag(+t.dataset.i);
    else toggle();
  };
  st.addEventListener('pointerup', end);
  st.addEventListener('pointercancel', end);
  st.addEventListener('wheel', (e) => {
    e.preventDefault();
    setPos(P.pos + e.deltaY);
    P.dirty = true;
    saveSettingsSoon();
  }, { passive: false });
}

/* ============================================================
   7. KEYBOARD, ROUTING, STARTUP
   ============================================================ */
function onKey(e) {
  if (modalOpen()) return;
  if (location.hash.indexOf('#/s/') !== 0 || !P.s) return;
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
  if (e.key === 'Escape') {
    if (anyPanelOpen()) { e.preventDefault(); closeAllPanels(); }
    return;
  }
  if (typing || anyPanelOpen()) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case ' ': case 'Spacebar': e.preventDefault(); toggle(); break;
    case 'ArrowUp': e.preventDefault(); changeSpeed(1); break;
    case 'ArrowDown': e.preventDefault(); changeSpeed(-1); break;
    case 'ArrowRight': case 'PageDown': e.preventDefault(); nudge(1); break;
    case 'ArrowLeft': case 'PageUp': e.preventDefault(); nudge(-1); break;
    case '+': case '=': e.preventDefault(); changeFont(4); break;
    case '-': case '_': e.preventDefault(); changeFont(-4); break;
    default: return;
  }
}

const VIEWS = ['#view-library', '#view-add', '#view-prompter', '#view-bank'];
function showView(sel) {
  VIEWS.forEach((v) => ($(v).hidden = v !== sel));
  window.scrollTo(0, 0);
}
function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}
function leavePrompter() {
  if (P.s) { pause(); saveNow(); }
  closeAllPanels();
  P.s = null;
}
function route() {
  const h = location.hash || '#/';
  let m;
  if ((m = h.match(/^#\/s\/(.+)$/))) {
    showView('#view-prompter');
    openPrompter(decodeURIComponent(m[1]));
  } else if (h === '#/notes') {
    leavePrompter();
    renderBank();
    showView('#view-bank');
  } else if (h === '#/add') {
    leavePrompter();
    showAdd(null);
    showView('#view-add');
  } else if ((m = h.match(/^#\/replace\/(.+)$/))) {
    leavePrompter();
    showAdd(decodeURIComponent(m[1]));
    showView('#view-add');
  } else {
    leavePrompter();
    renderLibrary();
    showView('#view-library');
  }
}

const SAMPLE = `# Opening
[Walk to center · pause and smile]
Good morning, church. It is so good to be together.
[Slide 1 · The Talents]
This morning we're going to look at a story Jesus told about money, trust, and courage.

# The Story
[Slide 2 · Matthew 25:14-15]
> For it will be like a man going on a journey, who called his servants and entrusted to them his property.
> To one he gave five talents, to another two, to another one, to each according to his ability.
Notice something right away. The master gives before he asks for anything back.
[Slide 3]
Every one of us has been handed something. The question is never whether you got enough. The question is what you will do with it.

# The Fear
[Lower voice · slow down]
The third servant didn't lose the money. He buried it.
> I was afraid, and I went and hid your talent in the ground.
Fear doesn't always look like running away. Sometimes it looks like playing it safe.

# Closing
[Slide 4 · Your next step]
So here is my question for you this week: what have you buried?
Let's pray.
[Band comes up · worship leader to stage]`;

function init() {
  // library
  $('#btn-add').addEventListener('click', () => go('#/add'));
  $('#btn-sample').addEventListener('click', () => {
    const s = newScript('Sample: The Parable of the Talents', SAMPLE);
    s.target = 10 * 60;
    Store.save(s);
    renderLibrary();
  });
  $('#btn-export').addEventListener('click', exportBackup);
  $('#btn-bank').addEventListener('click', () => go('#/notes'));
  $('#bank-back').addEventListener('click', () => go('#/'));
  $('#bank-copy').addEventListener('click', async () => {
    if (await copyText($('#bank-text').value, $('#bank-text'))) toast('All notes copied — paste them into Claude, then Clear all');
  });
  $('#bank-clear').addEventListener('click', clearBank);
  $('#bank-sync').addEventListener('click', () => syncTap(Store.all().filter((s) => s.drive).map((s) => s.id), renderBank));
  $('#add-drive').addEventListener('click', addFromDrive);
  $('#n-sync').addEventListener('click', () => syncTap([P.s.id]));
  window.addEventListener('online', () => GDrive.preload());
  if (navigator.onLine) setTimeout(() => GDrive.preload(), 1500);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ''; });

  // add
  $('#add-back').addEventListener('click', () => go('#/'));
  $('#add-cancel').addEventListener('click', () => go('#/'));
  $('#add-save').addEventListener('click', saveAdd);
  $('#add-file').addEventListener('change', (e) => { handleAddFile(e.target.files[0]); e.target.value = ''; });
  const drop = $('#drop');
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#add-file').click(); } });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
  // allow dropping a file anywhere on the add or library screens
  document.addEventListener('dragover', (e) => { if (!$('#view-prompter').hidden) return; e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (!$('#view-prompter').hidden) return;
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (!f) return;
    if (!$('#view-library').hidden) { go('#/add'); setTimeout(() => handleAddFile(f), 50); }
    else handleAddFile(f);
  });

  // prompter controls
  $('#b-home').addEventListener('click', () => go('#/'));
  $('#b-play').addEventListener('click', toggle);
  $('#b-slower').addEventListener('click', () => changeSpeed(-1));
  $('#b-faster').addEventListener('click', () => changeSpeed(1));
  $('#b-smaller').addEventListener('click', () => changeFont(-4));
  $('#b-bigger').addEventListener('click', () => changeFont(4));
  $('#b-mirror').addEventListener('click', toggleMirror);
  $('#b-jump').addEventListener('click', openJump);
  $('#b-notes').addEventListener('click', openNotes);
  $('#scrim').addEventListener('click', closeAllPanels);
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeAllPanels));
  $('#flag-save').addEventListener('click', saveFlag);
  $('#flag-remove').addEventListener('click', removeFlag);
  $('#flag-cancel').addEventListener('click', closeAllPanels);
  $('#n-copy').addEventListener('click', copyNotes);
  $('#n-reset').addEventListener('click', () => resetTimes(false));
  $('#n-clear').addEventListener('click', clearFlags);
  $('#n-saverun').addEventListener('click', () => { saveRun(); renderNotes(); toast('Run saved'); });

  // bar: first touch on a faded bar only reveals it
  const bar = $('#bar');
  let swallow = false;
  bar.addEventListener('pointerdown', () => { if (bar.classList.contains('faded')) swallow = true; pokeBar(); }, true);
  bar.addEventListener('click', (e) => { if (swallow) { swallow = false; e.stopPropagation(); e.preventDefault(); } }, true);
  $('#view-prompter').addEventListener('mousemove', () => { if (P.playing) pokeBar(); });

  setupStage();
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', () => { if (P.s) layout(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && P.s) { pause(); saveNow(); }
  });
  window.addEventListener('pagehide', () => { if (P.s) saveNow(); });
  window.addEventListener('hashchange', route);

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // wait for the font so measurements are right
  const start = () => route();
  if (document.fonts && document.fonts.ready) {
    Promise.race([document.fonts.load('400 20px Atkinson'), new Promise((r) => setTimeout(r, 800))]).then(start, start);
  } else start();
}

init();
