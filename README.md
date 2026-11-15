# Prompter

A teleprompter for preaching and speaking. Installable web app, works offline, no accounts or server. Everything is saved on the device.

## Files

| File | What it does |
|---|---|
| `index.html` | The screens (library, add script, prompter, panels) |
| `styles.css` | All the look and feel (colors are at the top) |
| `parse.js` | Reads scripts: headings, `[cues]`, `[Slide N]`, `> scripture` |
| `app.js` | Everything else: library, prompter, timers, flags, notes, sync |
| `gdrive.js` | Google Drive: sign-in, file picker, reading Docs, writing the notes Doc |
| `sw.js` | Offline support (caches the app on the device) |
| `manifest.webmanifest` | App name and icon for "Add to Home Screen" |
| `lib/` | mammoth.js 1.8.0 (reads Word files) pdf.js 3.11.174 (reads PDFs), JSZip 3.10.1 (finds section breaks in Word files) |
| `fonts/` | Atkinson Hyperlegible |
| `icons/` | App icons |

## Making a change

1. Edit the file.
2. Open `sw.js` and bump the version: `prompter-v1` → `prompter-v2`. **If you skip this, installed copies won't update.**
3. Upload the changed files to GitHub. Devices pick up the new version the next time they open the app with internet (sometimes it takes closing and reopening twice).

## Script format

```
# Section heading          (also ## and ###, or Word Heading 1/2/3)
A normal line.
[Walk to the left]         stage cue: small, italic, dimmed
[Slide 5 · Matthew 25:14]  gold "▶ Slide 5" chip
> For it will be like…     scripture: indented, green bar, italic
```

With no headings at all, short lines (8 words or fewer, no ending punctuation) become sections.

## Keys (keyboard or Bluetooth page turner)

Space = play/pause · ↑/↓ = speed · ←/→ (or Page Up/Down) = back/forward a quarter screen · + / − = text size · Esc = close panel

## Google Drive sync

- Google Cloud project: **Prompter** (`prompter-514723`), owned by your Google account. Sign-in is in *Testing* mode: only accounts listed under **Google Auth Platform → Audience → Test users** can sign in.
- The sign-in ID and picker key in `gdrive.js` are public identifiers locked to `https://treylemmon.github.io` (and `http://localhost:8766` for testing).
- Prompter only sees Docs you pick and the notes files it creates (Google's `drive.file` permission).
- **Sync** = pull the linked Doc (flags on unchanged lines are kept) → write `<title> — Prompter notes` into the **Prompter notes** folder in Drive.
