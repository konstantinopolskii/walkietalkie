/* TalkTrack — service worker.
 *
 * Owns the single source of truth for session state. Coordinates the
 * offscreen document (audio capture) and content scripts (DOM event
 * capture), then writes audio + log.txt + events.jsonl to disk via the
 * downloads API when the session stops.
 *
 * Wire:
 *   popup ──start/stop──▶ background ──┬──▶ offscreen (audio)
 *                                      └──▶ content scripts (DOM events)
 *   offscreen ──audio dataUrl──▶ background
 *   content  ──events──▶ background
 *   background ──downloads.download──▶ ~/Downloads/talktrack/session-<id>/
 */

const OFFSCREEN_URL = "offscreen.html";
const SESSION_KEY = "talktrack:session";
const LAST_KEY = "talktrack:last";

let session = null; // { id, startedAt, events: [], audioReady: false }

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Record microphone audio for the active TalkTrack session."
  });
}

async function closeOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) await chrome.offscreen.closeDocument();
}

function newSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate())
  ].join("") + "-" + [
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds())
  ].join("");
}

async function broadcastToTabs(message) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) continue;
    chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  }
}

async function startSession() {
  if (session) return { ok: false, reason: "already-running" };
  const id = newSessionId();
  session = {
    id,
    startedAt: Date.now(),
    events: [],
    audioReady: false
  };
  await chrome.storage.session.set({ [SESSION_KEY]: { id, startedAt: session.startedAt } });

  await ensureOffscreen();
  await chrome.runtime.sendMessage({ target: "offscreen", type: "start", sessionId: id }).catch(() => {});
  await broadcastToTabs({ target: "content", type: "start", sessionId: id, startedAt: session.startedAt });

  return { ok: true, id, startedAt: session.startedAt };
}

async function stopSession() {
  if (!session) return { ok: false, reason: "not-running" };

  const events = session.events.slice();
  await broadcastToTabs({ target: "content", type: "stop" });

  const audio = await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" }).catch(() => null);

  const meta = {
    id: session.id,
    startedAt: session.startedAt,
    stoppedAt: Date.now(),
    durationMs: Date.now() - session.startedAt,
    events: events.length,
    userAgent: navigator.userAgent
  };

  const folder = `talktrack/session-${session.id}`;
  const writes = [];

  if (audio?.dataUrl) {
    writes.push(downloadFile(`${folder}/audio.${audio.ext || "webm"}`, audio.dataUrl));
  }

  writes.push(downloadFile(`${folder}/log.txt`, toDataUrl("text/plain", renderLog(meta, events))));
  writes.push(downloadFile(`${folder}/events.jsonl`, toDataUrl("application/jsonl", events.map((e) => JSON.stringify(e)).join("\n") + "\n")));
  writes.push(downloadFile(`${folder}/session.json`, toDataUrl("application/json", JSON.stringify(meta, null, 2))));

  const ids = await Promise.all(writes);

  session = null;
  await chrome.storage.session.remove(SESSION_KEY);
  await closeOffscreen();

  const last = {
    id: meta.id,
    folder,
    durationMs: meta.durationMs,
    events: meta.events,
    downloadId: ids.find(Boolean) || null
  };
  await chrome.storage.local.set({ [LAST_KEY]: last });

  return { ok: true, last };
}

function toDataUrl(mime, text) {
  // base64 encode utf-8 string
  const utf8 = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}

function downloadFile(filename, url) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      { url, filename, conflictAction: "uniquify", saveAs: false },
      (id) => resolve(id || null)
    );
  });
}

function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const cs = Math.floor((ms % 1000) / 10);
  const pad = (n, w) => String(n).padStart(w, "0");
  return `${pad(m, 2)}:${pad(s, 2)}.${pad(cs, 2)}`;
}

function renderLog(meta, events) {
  const lines = [];
  const startedAt = new Date(meta.startedAt).toISOString();
  const stoppedAt = new Date(meta.stoppedAt).toISOString();
  lines.push(`TalkTrack session ${meta.id}`);
  lines.push(`started: ${startedAt}`);
  lines.push(`stopped: ${stoppedAt}`);
  lines.push(`duration: ${fmtClock(meta.durationMs)}`);
  lines.push(`events: ${meta.events}`);
  lines.push("");
  for (const ev of events) {
    const t = fmtClock(ev.t);
    const head = `[${t}] ${ev.kind}${ev.label ? ` → ${ev.label}` : ""}`;
    lines.push(head);
    if (ev.url) lines.push(`  url: ${ev.url}`);
    if (ev.selector) lines.push(`  selector: ${ev.selector}`);
    if (ev.text) lines.push(`  text: ${JSON.stringify(ev.text)}`);
    if (ev.bbox) lines.push(`  bbox: ${ev.bbox.x},${ev.bbox.y} ${ev.bbox.w}x${ev.bbox.h}`);
    if (ev.viewport) lines.push(`  viewport: scroll ${ev.viewport.scrollX},${ev.viewport.scrollY} of ${ev.viewport.w}x${ev.viewport.h}`);
    if (ev.value !== undefined) lines.push(`  value: ${JSON.stringify(ev.value)}`);
    if (ev.key) lines.push(`  key: ${ev.key}`);
    if (ev.attrs) {
      for (const [k, v] of Object.entries(ev.attrs)) {
        if (v == null || v === "") continue;
        lines.push(`  ${k}: ${v}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if (message.target && message.target !== "background") return false;

  switch (message.type) {
    case "popup:start":
      startSession().then(sendResponse);
      return true;
    case "popup:stop":
      stopSession().then(sendResponse);
      return true;
    case "popup:state":
      (async () => {
        const last = (await chrome.storage.local.get(LAST_KEY))[LAST_KEY] || null;
        sendResponse({
          recording: !!session,
          startedAt: session?.startedAt || null,
          last
        });
      })();
      return true;
    case "content:event":
      if (session) {
        session.events.push(message.event);
      }
      sendResponse({ ok: !!session });
      return false;
    case "content:hello":
      sendResponse({
        recording: !!session,
        sessionId: session?.id || null,
        startedAt: session?.startedAt || null
      });
      return false;
    default:
      return false;
  }
});

// On install, clear any stale session state so we don't think we're recording
// after a service worker restart with no offscreen doc.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.remove(SESSION_KEY).catch(() => {});
});
