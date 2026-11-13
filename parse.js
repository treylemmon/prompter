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
      .filter((l) => l.trim() !== '');

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
  async function docxToText(arrayBuffer) {
    const mammoth = window.mammoth;
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

  return { parse, tokens, plainText, docxToText, norm };
})();
