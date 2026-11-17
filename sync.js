/* Prompter — sync across devices through Google Drive.
   Every device keeps working on its own copy (offline is fine). When online and signed in,
   it merges with "Prompter library.json" in the Prompter notes folder:
   - flags merge line by line (newest edit wins, removed flags stay removed)
   - title/text/target, times, and settings each take the newest version
   - run history is combined; deleted scripts stay deleted
   - reading position and recordings stay on each device. */
'use strict';

const LibSync = (() => {
  const ON_KEY = 'prompter.libsync';
  const LAST_KEY = 'prompter.libsync.last';
  const KEEP_TOMBSTONES = 180 * 24 * 3600 * 1000;
  let running = false, again = false, timer = null, interval = null, lastError = '';

  const enabled = () => { try { return localStorage.getItem(ON_KEY) === 'on'; } catch { return false; } };
  const lastSync = () => { try { return Number(localStorage.getItem(LAST_KEY)) || 0; } catch { return 0; } };

  /* ---------- merging ---------- */
  const groupTime = (s, g) => (s.v && s.v[g]) || s.updatedAt || s.createdAt || 0;
  function newest(s) {
    let t = Math.max(s.updatedAt || 0, ...Object.values(s.v || {}));
    for (const f of Object.values(s.flags || {})) t = Math.max(t, f.at || 0);
    return t;
  }

  function mergeScript(L, R) {
    const out = JSON.parse(JSON.stringify(L));
    out.v = { ...(L.v || {}) };
    if (groupTime(R, 'meta') > groupTime(L, 'meta')) {
      out.title = R.title; out.source = R.source; out.target = R.target;
      out.drive = R.drive ? { ...R.drive } : undefined;
      if (!out.drive) delete out.drive;
      out.v.meta = groupTime(R, 'meta');
    }
    if (groupTime(R, 'times') > groupTime(L, 'times')) {
      out.times = JSON.parse(JSON.stringify(R.times || { total: 0, sections: {}, finished: false }));
      out.v.times = groupTime(R, 'times');
    }
    if (groupTime(R, 'settings') > groupTime(L, 'settings')) {
      out.settings = { ...(R.settings || {}), pos: (L.settings && L.settings.pos) || 0 };
      out.v.settings = groupTime(R, 'settings');
    }
    // flags: newest edit per line wins; a removal newer than the flag wins
    const del = { ...(L.flagDel || {}) };
    for (const [k, t] of Object.entries(R.flagDel || {})) del[k] = Math.max(del[k] || 0, t);
    const flags = {};
    const keys = new Set([...Object.keys(L.flags || {}), ...Object.keys(R.flags || {})]);
    for (const k of keys) {
      const a = (L.flags || {})[k], b = (R.flags || {})[k];
      const f = !a ? b : !b ? a : (b.at || 0) > (a.at || 0) ? b : a;
      if (f && (f.at || 0) >= (del[k] || 0)) flags[k] = f;
    }
    out.flags = flags;
    const cutoff = Date.now() - KEEP_TOMBSTONES;
    out.flagDel = Object.fromEntries(Object.entries(del).filter(([k, t]) => t > cutoff && !flags[k]));
    // run history: combine
    const runs = new Map();
    for (const r of [...(L.runs || []), ...(R.runs || [])]) runs.set(r.date + '|' + r.total, r);
    out.runs = [...runs.values()].sort((a, b) => a.date - b.date);
    out.createdAt = Math.min(L.createdAt || Infinity, R.createdAt || Infinity);
    out.updatedAt = Math.max(L.updatedAt || 0, R.updatedAt || 0);
    return out;
  }

  /** Same sermon added separately on two devices? (same Google Doc part, or identical text) */
  function twinOf(list, r) {
    return list.find((l) =>
      (l.drive && r.drive && l.drive.id === r.drive.id && (l.drive.part ?? null) === (r.drive.part ?? null)) ||
      (!l.drive && !r.drive && l.title === r.title && l.source === r.source));
  }

  /** Re-key a local script (and its recordings) to the id the other device uses. */
  async function rekey(s, newId) {
    const old = s.id;
    Store.remove(old, true);
    s.id = newId;
    Store.write(s);
    try {
      for (const t of await Media.list(old)) { t.scriptId = newId; await Media.put(t); }
    } catch {}
    if (P.s && P.s.id === old) { P.s.id = newId; history.replaceState(null, '', '#/s/' + newId); }
  }

  async function mergeAll(remote) {
    const changed = new Set();
    const localDel = Store.deleted(), remoteDel = remote.deleted || {};
    const del = { ...localDel };
    for (const [id, t] of Object.entries(remoteDel)) del[id] = Math.max(del[id] || 0, t);

    let local = Store.all();
    for (const r of remote.scripts || []) {
      if (!r || !r.id || typeof r.source !== 'string') continue;
      let l = local.find((x) => x.id === r.id);
      if (!l) {
        const twin = twinOf(local, r);
        if (twin) {
          if (r.id < twin.id) await rekey(twin, r.id);   // both devices settle on the same id
          else { r.id = twin.id; }
          l = twin;
          changed.add(l.id);
        }
      }
      if (!l) {
        if ((del[r.id] || 0) >= newest(r)) continue;     // deleted here after it last changed
        const add = JSON.parse(JSON.stringify(r));
        add.settings = { ...(add.settings || {}), pos: 0 };
        Store.write(add);
        changed.add(add.id);
        continue;
      }
      const before = JSON.stringify(l);
      const m = mergeScript(l, r);
      if (JSON.stringify(m) !== before) { Store.write(m); changed.add(m.id); }
    }
    // scripts deleted on another device
    for (const l of Store.all()) {
      if ((remoteDel[l.id] || 0) >= newest(l) && (remoteDel[l.id] || 0) > 0) {
        Store.remove(l.id, true);
        Media.removeForScript(l.id).catch(() => {});
        changed.add(l.id);
      }
    }
    const cutoff = Date.now() - KEEP_TOMBSTONES;
    for (const id of Object.keys(del)) if (del[id] < cutoff) delete del[id];
    Store.setDeleted(del);
    return changed;
  }

  function payload() {
    const scripts = Store.all().map((s) => {
      const c = JSON.parse(JSON.stringify(s));
      if (c.settings) delete c.settings.pos;
      return c;
    }).sort((a, b) => (a.id < b.id ? -1 : 1));
    return { app: 'Prompter', version: 1, scripts, deleted: Store.deleted() };
  }

  /* ---------- running a sync ---------- */
  /** True while it's not safe to swap the open script underneath you. */
  function busy() {
    return !!(P.s && (P.playing || Review.active() || !$('#sheet-flag').hidden || modalOpen()));
  }

  async function run() {
    if (!enabled() || !navigator.onLine) { paint(); return; }
    if (!GDrive.signedIn()) { paint(); return; }
    if (busy()) { again = true; return; }
    if (running) { again = true; return; }
    running = true;
    try {
      if (P.s) saveNow();
      const id = await GDrive.libraryFile();
      const remote = await GDrive.readJSON(id);
      if (busy()) { again = true; return; }          // something started while we were downloading
      const changed = await mergeAll(remote);
      const out = payload();
      const remoteSame = JSON.stringify({ ...remote, updated: undefined }) === JSON.stringify(out);
      if (!remoteSame) await GDrive.writeJSON(id, { ...out, updated: Date.now() });
      try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch {}
      lastError = '';
      if (changed.size) refreshViews(changed);
    } catch (e) {
      lastError = e.message || 'Sync failed';
    } finally {
      running = false;
      paint();
      if (again) { again = false; schedule(3000); }
    }
  }

  function refreshViews(changed) {
    if (P.s) {
      if (!Store.get(P.s.id)) {
        P.s = null; // don't save it back on the way out
        toast('This script was deleted on another device.');
        go('#/');
        return;
      }
      if (changed.has(P.s.id)) {
        openPrompter(P.s.id);
        if (!$('#panel-notes').hidden) { renderNotes(); renderRecordings(); }
        toast('Updated from your other device', 2500);
      }
    }
    if (!$('#view-library').hidden) renderLibrary();
    if (!$('#view-bank').hidden) renderBank();
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  }

  /* ---------- the bits you see ---------- */
  function paint() {
    const on = enabled();
    const needTap = on && navigator.onLine && !GDrive.signedIn();
    $('#btn-reconnect').hidden = !needTap;
    const st = $('#sync-status');
    if (!st) return;
    $('#sync-on').hidden = on;
    $('#sync-controls').hidden = !on;
    if (!on) { st.textContent = 'Keep your scripts, flags and times the same on your phone, iPad and computer.'; return; }
    const last = lastSync();
    st.textContent = !navigator.onLine ? 'Offline — changes will sync when you’re back online.'
      : needTap ? 'Tap “Reconnect Google” to keep syncing.'
      : lastError ? 'Sync problem: ' + lastError
      : last ? 'Synced across devices · ' + fmtAgo(last)
      : 'Syncing…';
  }

  /** From a tap: sign in if needed, then sync now. */
  function tapSync() {
    GDrive.withToken()
      .then(() => { try { localStorage.setItem(ON_KEY, 'on'); } catch {} paint(); return run(); })
      .then(() => { if (!lastError) toast('Synced across devices'); })
      .catch((e) => toast(e.message || 'Couldn’t sync.', 5000));
  }

  function turnOff() {
    try { localStorage.removeItem(ON_KEY); } catch {}
    paint();
    toast('Sync across devices is off on this device.');
  }

  function setup() {
    $('#btn-sync-on').addEventListener('click', tapSync);
    $('#btn-sync-now').addEventListener('click', tapSync);
    $('#btn-reconnect').addEventListener('click', tapSync);
    $('#btn-sync-off').addEventListener('click', turnOff);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(500); });
    window.addEventListener('online', () => { paint(); schedule(1000); });
    window.addEventListener('offline', paint);
    interval = setInterval(() => { if (!document.hidden) run(); }, 60000);
    setInterval(paint, 30000);
    paint();
    schedule(2500); // after Google's sign-in code has loaded
  }

  return {
    setup,
    run,
    paint,
    enabled,
    _merge: mergeAll, // for testing
    /** Called after every local save: sync a few seconds later (not mid-run). */
    changed() { if (enabled()) schedule(4000); },
  };
})();
