# TalkTrack

Chrome extension that records voice plus DOM interactions on any open page.
You hit start, talk through the page, click whatever catches you. TalkTrack
captures audio and a structured log of every click, selection, key combo,
text input, and scroll, and writes the bundle to disk when you stop.

## What lands on disk

Each session writes a folder under your Chrome download directory:

```
<chrome download dir>/talktrack/session-YYYYMMDD-HHMMSS/
├── audio.webm        — microphone capture, opus in webm
├── log.txt           — human-readable timeline
├── events.jsonl      — same events, one JSON per line
└── session.json      — metadata: started, stopped, duration, ua
```

On macOS the default download directory is `~/Downloads`. Point Chrome's
download location at `~/Documents` if you want sessions to land there.

After a session, the popup shows a paste-ready briefing — drop it into
your agent and it knows where to look and what each file holds:

```
TalkTrack session 20260426-114530
folder: ~/Downloads/talktrack/session-20260426-114530
duration: 3 min 12 sec, 47 events
files:
  audio.webm    microphone capture, opus in webm
  log.txt       human-readable timeline of clicks, selections, keys
  events.jsonl  same events, one JSON object per line
  session.json  metadata: started, stopped, duration, user agent

Read log.txt first for the timeline. Match timestamps in events.jsonl
for full DOM context (selector, bbox, attrs) on any moment.
```

## Install

Local dev:

```
npm install
# → vendors @kk/design-system into vendor/kk for the popup styles
```

Then in Chrome:
1. open `chrome://extensions`
2. toggle on **Developer mode**
3. click **Load unpacked** and pick this folder
4. pin the action so the popup is one click away
5. on first start, allow microphone access for the extension

## Pipeline

Designed against the kk-agentic-ds inspector card pattern. Popup composes
three cards in a single `inspector__group`: heading, recorder, last
session. No three-column shell, no off-grid tokens, no invented components.

## Stack

- Manifest V3 service worker (`background.js`) holds session state.
- Offscreen document (`offscreen.js`) runs the MediaRecorder.
- Content script (`content.js`) hooks click, contextmenu, keydown,
  selectionchange, input, and scroll on every host page.
- Popup (`popup.html` + `popup.js`) is the inspector card UI.
- Styles ship from `@kk/design-system` via `vendor/kk/`.
