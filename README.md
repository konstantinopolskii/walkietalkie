# WalkieTalkie

Chrome extension that records voice plus DOM interactions on any open page.
Click the icon to start, talk through the page, click whatever catches you,
hit stop. WalkieTalkie captures audio and a structured log of every click,
selection, key combo, text input, and scroll, writes the bundle to disk,
and copies a paste-ready agent briefing to your clipboard.

## How to drive it

- **Start**: click the WalkieTalkie icon in the toolbar. A 300×46 px glass
  overlay appears at the bottom of the active tab. The icon shows a `REC`
  badge while you're recording.
- **First click on any page element**: paints a black-and-white outline
  over it and logs a `highlight` event. The element's own action does
  not fire. Click again, anywhere, to commit (the page handles the click,
  logged as `click`). `Esc` cancels the highlight.
- **Click the live wave** in the overlay: opens a small mic picker. Pick
  a different input device — the recorder swaps streams in place (old
  chunks discarded, the whole point of swapping is "no sound, throw it out").
- **Stop**: click the stop square in the overlay (or the icon again).
  The briefing copies to your clipboard, the overlay flashes "Copied" and
  fades, the bundle lands on disk.

## What lands on disk

Each session writes a folder under your Chrome download directory:

```
<chrome download dir>/walkietalkie/session-YYYYMMDD-HHMMSS/
├── audio.m4a         — microphone capture, AAC in mp4 (or .webm fallback)
├── log.txt           — human-readable timeline of DOM events
├── events.jsonl      — same events, one JSON per line
└── session.json      — metadata: started, stopped, duration, audio, ua
```

Audio defaults to AAC in an mp4 container (`.m4a`) — light, universal,
plays in QuickTime, Music, Windows Media Player, VLC, anything modern.
On browsers that don't ship the AAC encoder it falls back to opus webm.
On macOS the default download directory is `~/Downloads`; point Chrome
at `~/Documents` if you want sessions to land there.

The clipboard briefing pasted into your agent looks like:

```
WalkieTalkie session 20260426-114530
folder: ~/Downloads/walkietalkie/session-20260426-114530
duration: 3 min 12 sec, 47 events
files:
  audio.m4a    microphone capture (m4a)
  log.txt      human-readable timeline of clicks, selections, keys
  events.jsonl same events, one JSON object per line
  session.json metadata: started, stopped, duration, audio, ua

Instructions for you (the agent):
1. Transcribe audio.m4a yourself.
2. Read log.txt and line up each voice segment with the DOM events
   by timestamp. Use events.jsonl for full DOM context (selector,
   bbox, attrs) on any moment.
3. If anything is unclear — what I meant, why I did something, where
   I want to take it next — ask before assuming.
4. After the analysis, summarize what you understood and confirm the
   direction with me before you act on it.
```

## Install

Local dev:

```
npm install
# → vendors @kk/design-system into vendor/kk for the setup-page styles
```

Then in Chrome:
1. open `chrome://extensions`
2. toggle on **Developer mode**
3. click **Load unpacked** and pick this folder
4. pin the action so the icon is one click away
5. first time, allow microphone access — Chrome shows a setup tab

## Stack

- Manifest V3 service worker (`background.js`) holds session state,
  writes the bundle, generates the briefing, drives the action toggle
  and the badge.
- Offscreen document (`offscreen.js`) owns MediaRecorder, the live
  AnalyserNode that feeds the wave, and the mid-session mic swap.
- Content script (`content.js`) renders the floating overlay in shadow
  DOM (wave + label + stop + mic popover), hooks click/contextmenu/
  keydown/selectionchange/input/scroll on every host page, and writes
  the briefing to the page's clipboard on stop.
- Setup page (`setup.html` + `setup.js`) handles the one-time mic grant
  Chrome won't show inside an extension popup.
- Styles ship from `@kk/design-system` via `vendor/kk/` (consumed by
  the setup page only).
