/* Prompter — Google Drive link.
   Lets a script come from a Google Doc and stay in sync with it:
   - "From Google Drive" picks a Doc (or Word file) and imports it.
   - "Sync" pulls the latest version of the Doc into Prompter (flags on unchanged lines are kept)
     and writes your flags, notes and times into a "<title> — Prompter notes" Google Doc
     (in a "Prompter notes" folder) that a Claude chat can read.
   Only the files you pick, and the notes files Prompter creates, are visible to Prompter
   (Google's "drive.file" permission). Everything else in your Drive stays private. */
'use strict';

const GDrive = (() => {
  // Public identifiers from the "Prompter" Google Cloud project (not secrets; locked to this website).
  const CLIENT_ID = '213465479717-igejqqiulalsfcr5t529t45p0qii3d9g.apps.googleusercontent.com';
  const API_KEY = 'AIzaSyBzmC4sY2s7SL4i02WmL0KT7flz_zqCsUQ';
  const APP_ID = '213465479717';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const DOC = 'application/vnd.google-apps.document';
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const FOLDER = 'application/vnd.google-apps.folder';
  const TOKEN_KEY = 'prompter.gtoken';
  const FOLDER_KEY = 'prompter.gfolder';

  let token = null, tokenExp = 0, tokenClient = null, pending = null;
  try {
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (saved && saved.exp > Date.now() + 60000) { token = saved.token; tokenExp = saved.exp; }
  } catch { /* ignore */ }

  const loads = {};
  function load(src) {
    loads[src] = loads[src] || new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = res;
      s.onerror = () => { delete loads[src]; rej(new Error('Couldn’t reach Google. Check your internet connection.')); };
      document.head.appendChild(s);
    });
    return loads[src];
  }

  /** Load Google's sign-in and picker code ahead of time, so a tap can open sign-in right away. */
  async function preload() {
    if (!navigator.onLine) return;
    try {
      await load('https://accounts.google.com/gsi/client');
      if (!tokenClient) {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: CLIENT_ID,
          scope: SCOPE,
          callback: (r) => {
            const p = pending; pending = null;
            if (!p) return;
            if (r.error) { p.rej(new Error('Google sign-in didn’t finish (' + r.error + ').')); return; }
            token = r.access_token;
            tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
            try { localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, exp: tokenExp })); } catch {}
            p.res(token);
          },
          error_callback: (e) => {
            const p = pending; pending = null;
            if (!p) return;
            const why = e && e.type === 'popup_closed' ? 'The Google sign-in window was closed.'
              : e && e.type === 'popup_failed_to_open' ? 'The Google sign-in window was blocked. Tap the button again.'
              : 'Google sign-in failed.';
            p.rej(new Error(why));
          },
        });
      }
      await load('https://apis.google.com/js/api.js');
      if (!window.google || !google.picker) await new Promise((res) => gapi.load('picker', res));
    } catch { /* offline or blocked; retried on next tap */ }
  }

  const signedIn = () => !!token && Date.now() < tokenExp - 60000;

  /**
   * Get a sign-in token. MUST be called straight from a tap (no awaits before it),
   * because Safari only allows the Google window to open from a tap.
   */
  function withToken() {
    if (!navigator.onLine) return Promise.reject(new Error('Google Drive needs an internet connection.'));
    if (signedIn()) return Promise.resolve(token);
    if (!tokenClient) {
      preload();
      return Promise.reject(new Error('Connecting to Google… tap again in a moment.'));
    }
    return new Promise((res, rej) => {
      pending = { res, rej };
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  function signOut() {
    if (token && window.google && google.accounts) google.accounts.oauth2.revoke(token, () => {});
    token = null; tokenExp = 0;
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(FOLDER_KEY); } catch {}
  }

  async function api(url, opts = {}) {
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
    if (r.status === 401) {
      token = null; tokenExp = 0;
      try { localStorage.removeItem(TOKEN_KEY); } catch {}
      throw new Error('Your Google sign-in expired. Tap the button again.');
    }
    if (!r.ok) {
      let msg = '';
      try { msg = (await r.json()).error.message; } catch {}
      const e = new Error(r.status === 404 ? 'not found' : 'Google Drive said: ' + (msg || r.status));
      e.status = r.status;
      throw e;
    }
    return r;
  }

  /** Open Google's file picker. Resolves to {id, name, mimeType} or null if cancelled. */
  function pick() {
    return new Promise((res, rej) => {
      if (!window.google || !google.picker) { rej(new Error('Google’s file picker is still loading. Tap again in a moment.')); return; }
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setMimeTypes([DOC, DOCX, 'text/plain', 'text/markdown'].join(','))
        .setMode(google.picker.DocsViewMode.LIST)
        .setIncludeFolders(true);
      const picker = new google.picker.PickerBuilder()
        .setAppId(APP_ID)
        .setOAuthToken(token)
        .setDeveloperKey(API_KEY)
        .addView(view)
        .setTitle('Choose a script')
        .setCallback((data) => {
          const a = data[google.picker.Response.ACTION];
          if (a === google.picker.Action.PICKED) {
            const d = data[google.picker.Response.DOCUMENTS][0];
            res({ id: d[google.picker.Document.ID], name: d[google.picker.Document.NAME], mimeType: d[google.picker.Document.MIME_TYPE] });
          } else if (a === google.picker.Action.CANCEL) res(null);
        })
        .build();
      picker.setVisible(true);
    });
  }

  const meta = async (id) =>
    (await api(`${DRIVE}/files/${id}?fields=id,name,mimeType,modifiedTime,webViewLink,trashed&supportsAllDrives=true`)).json();

  /** Read a Doc / Word / text file from Drive → our script text (headings as #, section breaks kept). */
  async function readText(file, loadWordReader) {
    if (file.mimeType === DOC || file.mimeType === DOCX) {
      await loadWordReader();
      const url = file.mimeType === DOC
        ? `${DRIVE}/files/${file.id}/export?mimeType=${encodeURIComponent(DOCX)}`
        : `${DRIVE}/files/${file.id}?alt=media&supportsAllDrives=true`;
      return Parser.docxToText(await (await api(url)).arrayBuffer());
    }
    return (await api(`${DRIVE}/files/${file.id}?alt=media&supportsAllDrives=true`)).text();
  }

  async function notesFolder() {
    let id = null;
    try { id = localStorage.getItem(FOLDER_KEY); } catch {}
    if (id) {
      try { const m = await meta(id); if (!m.trashed) return id; } catch {}
    }
    const q = encodeURIComponent(`name='Prompter notes' and mimeType='${FOLDER}' and trashed=false`);
    const found = await (await api(`${DRIVE}/files?q=${q}&fields=files(id)`)).json();
    if (found.files && found.files.length) id = found.files[0].id;
    else {
      const r = await api(`${DRIVE}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Prompter notes', mimeType: FOLDER }),
      });
      id = (await r.json()).id;
    }
    try { localStorage.setItem(FOLDER_KEY, id); } catch {}
    return id;
  }

  /** Create or overwrite the notes Google Doc. Returns its file id. */
  async function writeNotes(existingId, name, text) {
    if (existingId) {
      try {
        await api(`${UPLOAD}/files/${existingId}?uploadType=media`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
          body: text,
        });
        await api(`${DRIVE}/files/${existingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        return existingId;
      } catch (e) {
        if (e.status !== 404) throw e; // deleted → make a new one
      }
    }
    const folder = await notesFolder();
    const boundary = 'prompter' + Math.random().toString(36).slice(2);
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name, mimeType: DOC, parents: [folder] }) +
      `\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--`;
    const r = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body,
    });
    return (await r.json()).id;
  }

  const LIB_KEY = 'prompter.libfile';
  const LIB_NAME = 'Prompter library.json';

  /** Find (or create) the shared library file that keeps devices in sync. */
  async function libraryFile() {
    let id = null;
    try { id = localStorage.getItem(LIB_KEY); } catch {}
    if (id) {
      try { const m = await meta(id); if (!m.trashed) return id; } catch {}
    }
    const q = encodeURIComponent(`name='${LIB_NAME}' and trashed=false`);
    const found = await (await api(`${DRIVE}/files?q=${q}&orderBy=modifiedTime desc&fields=files(id)`)).json();
    if (found.files && found.files.length) id = found.files[0].id;
    else {
      const folder = await notesFolder();
      const boundary = 'prompter' + Math.random().toString(36).slice(2);
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name: LIB_NAME, mimeType: 'application/json', parents: [folder] }) +
        `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n{}\r\n--${boundary}--`;
      const r = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
        body,
      });
      id = (await r.json()).id;
    }
    try { localStorage.setItem(LIB_KEY, id); } catch {}
    return id;
  }
  async function readJSON(id) {
    const t = await (await api(`${DRIVE}/files/${id}?alt=media`, { cache: 'no-store' })).text();
    try { return JSON.parse(t || '{}'); } catch { return {}; }
  }
  async function writeJSON(id, obj) {
    await api(`${UPLOAD}/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    });
  }

  return { preload, withToken, signedIn, signOut, pick, meta, readText, writeNotes, libraryFile, readJSON, writeJSON, DOC, DOCX };
})();
