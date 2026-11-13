/* Prompter — script parsing.
   Turns plain text (with optional # headings) into sections and lines.
   Word files are first converted to this same text format (see docxToText). */
'use strict';

const Parser = (() => {
  const SLIDE_RE = /^slide\s*(\d+[a-z]?)\b\s*(?:[·•:|,\-–—]\s*)?(.*)$/i;
  const HEADING_RE = /^(#{1,6})\s+(.*)$/;
  const CUE_ONLY_RE = /^(\s*\[[^\]]*\]\s*)+$/;
  const LIST_RE = /^(\s*[-*•]\s+|\s*\d+[.)]\s+)/;
  const END_PUNCT_RE = /[.!?,;:…"'”’)\]]$/;

  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  /** A line that separates scripts. Word/Google Docs section breaks become this line on import. */
  const BREAK_LINE = '=== SECTION BREAK ===';
  const BREAK_RE = /^\s*=+\s*section\s+break\s*=+\s*$/i;

  /** Split text at section-break lines → array of non-empty parts. */
  function splitParts(source) {
    const parts = [];
    let cur = [];
    for (const line of String(source || '').replace(/\r\n?/g, '\n').split('\n')) {
      if (BREAK_RE.test(line)) { parts.push(cur.join('\n')); cur = []; }
      else cur.push(line);
    }
    parts.push(cur.join('\n'));
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  /** A title for a part: its first heading, else its first line. */
  function partTitle(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const h = lines.find((l) => /^#{1,6}\s+/.test(l));
    const t = (h ? h.replace(/^#+\s+/, '') : lines[0] || 'Untitled script').replace(/^>+\s*/, '');
    return t.length > 70 ? t.slice(0, 67) + '…' : t;
  }

  function cleanMarkdown(s) {
    return s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
  }

  function wordCount(s) {
    return s.split(/\s+/).filter(Boolean).length;
  }

  /** A short line with no ending punctuation reads like a heading. */
  function looksLikeHeading(line) {
    const t = line.trim();
    if (!t || !/[A-Za-z0-9]/.test(t)) return false;
    if (t.startsWith('>') || t.startsWith('[') || LIST_RE.test(t)) return false;
    if (END_PUNCT_RE.test(t)) return false;
    return wordCount(t) <= 8;
  }

  /**
   * parse(source) → { sections: [{ title, key, items: [...] }], items: [...] }
   * item: { i, type: 'h'|'p'|'cue'|'scripture', level, text, raw, key, sec }
   */
  function parse(source) {
    const lines = String(source || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((l) => cleanMarkdown(l.replace(/\s+$/, '')))
      .filter((l) => l.trim() !== '' && !BREAK_RE.test(l));

    const hasHeadings = lines.some((l) => HEADING_RE.test(l.trim()));
    const items = [];
    const sections = [];
    const lineCounts = new Map();
    const secCounts = new Map();

    const startSection = (title) => {
      const t = norm(title) || 'Untitled section';
      const n = (secCounts.get(t) || 0) + 1;
      secCounts.set(t, n);
      sections.push({ title: t, key: n + '|' + t, items: [] });
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      let item;
      const hm = line.match(HEADING_RE);
      if (hm) {
        item = { type: 'h', level: Math.min(hm[1].length, 3), text: hm[2].trim() };
      } else if (line.startsWith('>')) {
        item = { type: 'scripture', text: line.replace(/^>+\s?/, '') };
      } else if (CUE_ONLY_RE.test(line)) {
        item = { type: 'cue', text: line };
      } else if (!hasHeadings && looksLikeHeading(line)) {
        item = { type: 'h', level: 2, text: line };
      } else {
        item = { type: 'p', text: line };
      }

      if (item.type === 'h') startSection(item.text);
      else if (!sections.length) startSection('Opening');

      const k = norm(line);
      const n = (lineCounts.get(k) || 0) + 1;
      lineCounts.set(k, n);
      item.raw = line;
      item.key = n + '|' + k;
      item.i = items.length;
      item.sec = sections.length - 1;
      items.push(item);
      sections[item.sec].items.push(item);
    }
    return { sections, items };
  }

  /** Split text into plain and [bracket] tokens. */
  function tokens(text) {
    const out = [];
    const re = /\[([^\]]*)\]/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
      const inner = m[1].trim();
      const sm = inner.match(SLIDE_RE);
      if (sm) out.push({ kind: 'slide', num: sm[1], rest: sm[2].trim() });
      else out.push({ kind: 'cue', text: '[' + inner + ']' });
      last = re.lastIndex;
    }
    if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
    return out;
  }

  /** Plain-text version of a line, used for notes. */
  function plainText(item) {
    return norm(item.text);
  }

  /** Convert a .docx (ArrayBuffer) into our text format, keeping heading levels. */
  /**
   * Word stores a section break as <w:sectPr> inside the last paragraph of each section.
   * We add a visible marker paragraph after each one, so the break survives conversion.
   * (The final <w:sectPr> sits directly in <w:body>; that one is not a break.)
   */
  async function markSectionBreaks(arrayBuffer) {
    if (!window.JSZip) return arrayBuffer;
    const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
    const zip = await window.JSZip.loadAsync(arrayBuffer);
    const f = zip.file('word/document.xml');
    if (!f) return arrayBuffer;
    const doc = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return arrayBuffer;
    const breaks = [...doc.getElementsByTagNameNS(W, 'sectPr')].filter(
      (sp) => sp.parentNode && sp.parentNode.localName === 'pPr'
    );
    if (!breaks.length) return arrayBuffer;
    for (const sp of breaks) {
      const para = sp.parentNode.parentNode; // w:p
      const p = doc.createElementNS(W, 'w:p');
      const r = doc.createElementNS(W, 'w:r');
      const t = doc.createElementNS(W, 'w:t');
      t.textContent = BREAK_LINE;
      r.appendChild(t); p.appendChild(r);
      para.parentNode.insertBefore(p, para.nextSibling);
    }
    zip.file('word/document.xml', new XMLSerializer().serializeToString(doc));
    return zip.generateAsync({ type: 'arraybuffer' });
  }

  async function docxToText(arrayBuffer) {
    const mammoth = window.mammoth;
    try { arrayBuffer = await markSectionBreaks(arrayBuffer); } catch (e) { /* fall back to no splitting */ }
    const result = await mammoth.convertToHtml(
      { arrayBuffer },
      {
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => h2:fresh",
          "p[style-name='Quote'] => blockquote > p:fresh",
          "p[style-name='Intense Quote'] => blockquote > p:fresh",
        ],
        convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })),
      }
    );
    const doc = new DOMParser().parseFromString(result.value, 'text/html');
    const out = [];

    const textOf = (el) => {
      const c = el.cloneNode(true);
      c.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
      return c.textContent.split('\n').map((s) => s.trim()).filter(Boolean);
    };

    const walk = (node, quote) => {
      for (const el of node.children) {
        const tag = el.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) {
          const level = Math.min(parseInt(tag[1], 10), 3);
          const t = norm(el.textContent);
          if (t) out.push('#'.repeat(level) + ' ' + t);
        } else if (tag === 'blockquote') {
          walk(el, true);
        } else if (tag === 'ul' || tag === 'ol' || tag === 'table' || tag === 'tbody' || tag === 'thead' || tag === 'tr') {
          walk(el, quote);
        } else if (tag === 'li' || tag === 'td' || tag === 'th') {
          if (el.querySelector('p, ul, ol, h1, h2, h3')) walk(el, quote);
          else textOf(el).forEach((t) => out.push((quote ? '> ' : '') + t));
        } else {
          textOf(el).forEach((t) => out.push((quote ? '> ' : '') + t));
        }
      }
    };
    walk(doc.body, false);
    return out.join('\n\n');
  }

  /**
   * Convert a PDF (ArrayBuffer) into our text format.
   * PDFs only store positioned text, so we rebuild lines from positions,
   * treat noticeably bigger text as headings, and re-join wrapped lines into paragraphs.
   */
  async function pdfToText(arrayBuffer) {
    const pdfjsLib = window.pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer), isEvalSupported: false }).promise;
    } catch (e) {
      if (e && e.name === 'PasswordException') throw new Error('This PDF is password-protected. Remove the password and try again.');
      throw new Error('Could not read that PDF.');
    }

    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const its = tc.items
        .filter((i) => typeof i.str === 'string' && i.str.length)
        .map((i) => ({
          s: i.str,
          x: i.transform[4],
          y: i.transform[5],
          w: i.width,
          size: Math.round((Math.hypot(i.transform[2], i.transform[3]) || i.height || 0) * 2) / 2,
        }));
      its.sort((a, b) => b.y - a.y || a.x - b.x);

      // group into rows by baseline
      const rows = [];
      for (const it of its) {
        const r = rows[rows.length - 1];
        if (r && Math.abs(r.y - it.y) <= Math.max(2, it.size * 0.35)) r.items.push(it);
        else rows.push({ y: it.y, items: [it] });
      }
      const pageLines = [];
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        let text = '', end = null, size = 0;
        for (const it of r.items) {
          if (it.s.trim()) size = Math.max(size, it.size);
          if (end != null && it.x - end > (it.size || 10) * 0.18 && !/\s$/.test(text) && !/^\s/.test(it.s)) text += ' ';
          text += it.s;
          end = it.x + it.w;
        }
        text = text.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (/^(page\s*)?\d+(\s*(of|\/)\s*\d+)?$/i.test(text)) continue; // page numbers
        pageLines.push({ text, size: size || 10, x: r.items[0].x, right: end, y: r.y, page: p });
      }
      // page text block edges, for spotting short (paragraph-ending) lines
      const left = Math.min(...pageLines.map((l) => l.x));
      const right = Math.max(...pageLines.map((l) => l.right));
      pageLines.forEach((l) => { l.left = left; l.full = l.right >= left + (right - left) * 0.8; });
      lines.push(...pageLines);
    }

    const chars = lines.reduce((n, l) => n + l.text.length, 0);
    if (chars < 20) throw new Error('This PDF has no readable text — it may be a scanned image. Try the original Word file instead.');

    // most common text size = body text
    const weight = new Map();
    for (const l of lines) weight.set(l.size, (weight.get(l.size) || 0) + l.text.length);
    const body = [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const headSizes = [...new Set(lines.map((l) => l.size).filter((s) => s >= body * 1.15))].sort((a, b) => b - a);
    const levelOf = (s) => Math.min(headSizes.indexOf(s) + 1, 3);

    const out = [];
    let prev = null;
    for (const l of lines) {
      const isHead = headSizes.includes(l.size) && l.text.split(' ').length <= 14;
      const standalone = isHead || /^[\[>]/.test(l.text) || /^([-*•]|\d+[.)])\s/.test(l.text);
      const canJoin =
        prev && !prev.head && !standalone && !/\]$/.test(prev.text) &&
        (prev.full || (/[A-Za-z]-$/.test(prev.text) && /^[a-z]/.test(l.text))) &&
        Math.abs(l.size - prev.size) < 1 &&
        Math.abs(l.x - prev.x) < l.size * 1.2 &&
        (l.page === prev.page ? prev.y - l.y <= l.size * 1.6 : true);
      if (canJoin) {
        const last = out.length - 1;
        if (/[A-Za-z]-$/.test(out[last]) && /^[a-z]/.test(l.text)) out[last] = out[last].slice(0, -1) + l.text;
        else out[last] += ' ' + l.text;
      } else {
        out.push(isHead ? '#'.repeat(levelOf(l.size)) + ' ' + l.text : l.text);
      }
      prev = { ...l, head: isHead };
    }
    return out.join('\n\n');
  }

  return { parse, tokens, plainText, docxToText, pdfToText, norm, splitParts, partTitle, BREAK_RE };
})();
