/* WalkieTalkie — service worker.
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
 *   background ──downloads.download──▶ ~/Downloads/walkietalkie/session-<id>/
 */

const OFFSCREEN_URL = "offscreen.html";
const SESSION_KEY = "walkietalkie:session";
const LAST_KEY = "walkietalkie:last";

let session = null;
let offscreenReadyResolver = null;

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;
  // chrome.offscreen.createDocument resolves when the document loads, but
  // the offscreen script's onMessage listener may not be attached yet.
  // Wait for the offscreen doc to ping back with offscreen:ready before
  // any subsequent message is sent — otherwise the start command lands
  // in the void and audio capture silently never begins.
  const ready = new Promise((resolve) => {
    offscreenReadyResolver = resolve;
    setTimeout(resolve, 3000); // safety: don't hang forever
  });
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Record microphone audio for the active WalkieTalkie session."
  });
  await ready;
  offscreenReadyResolver = null;
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

// Hot path: level samples land here ~12 times/sec while recording. We
// forward to the visible window's tabs only — backgrounded tabs don't
// render the overlay, so the wave there would burn cycles for nothing.
let levelBroadcastInflight = false;
async function broadcastLevel(level) {
  if (levelBroadcastInflight) return;
  levelBroadcastInflight = true;
  try {
    const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
    for (const w of windows) {
      if (w.state === "minimized") continue;
      const tabs = await chrome.tabs.query({ windowId: w.id, active: true });
      for (const tab of tabs) {
        if (!tab.id || !tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) continue;
        chrome.tabs.sendMessage(tab.id, { target: "content", type: "level", level }).catch(() => {});
      }
    }
  } finally {
    levelBroadcastInflight = false;
  }
}

async function startSession() {
  if (session) return { ok: false, reason: "already-running" };
  const id = newSessionId();
  session = {
    id,
    startedAt: Date.now(),
    events: [],
    audio: { ok: null, error: null, mime: null }
  };
  await chrome.storage.session.set({ [SESSION_KEY]: { id, startedAt: session.startedAt } });

  await ensureOffscreen();

  const audioRes = await chrome.runtime.sendMessage({
    target: "offscreen", type: "start", sessionId: id
  }).catch((e) => ({ ok: false, reason: "send-failed", error: String(e?.message || e) }));

  if (audioRes && audioRes.ok) {
    session.audio = { ok: true, error: null, mime: audioRes.mime || null };
  } else {
    session.audio = {
      ok: false,
      error: audioRes?.reason || "no-response",
      detail: audioRes?.error || null,
      mime: null
    };
  }

  await broadcastToTabs({ target: "content", type: "start", sessionId: id, startedAt: session.startedAt });

  return {
    ok: true,
    id,
    startedAt: session.startedAt,
    audio: session.audio
  };
}

async function stopSession() {
  if (!session) return { ok: false, reason: "not-running" };

  const events = session.events.slice();
  await broadcastToTabs({ target: "content", type: "stop" });

  const audio = await chrome.runtime.sendMessage({ target: "offscreen", type: "stop" })
    .catch((e) => ({ ok: false, reason: "send-failed", error: String(e?.message || e) }));

  const audioExt = audio?.ext || "webm";

  const meta = {
    id: session.id,
    startedAt: session.startedAt,
    stoppedAt: Date.now(),
    durationMs: Date.now() - session.startedAt,
    events: events.length,
    userAgent: navigator.userAgent,
    audio: {
      ok: !!(audio && audio.ok && audio.dataUrl),
      ext: audioExt,
      mime: audio?.mime || session.audio?.mime || null,
      bytes: audio?.bytes || 0,
      error: !audio || !audio.ok ? (audio?.reason || session.audio?.error || "no-response") : null,
      detail: audio?.error || session.audio?.detail || null
    }
  };

  const folder = `walkietalkie/session-${session.id}`;
  const writes = [];

  if (audio && audio.ok && audio.dataUrl) {
    writes.push(downloadFile(`${folder}/audio.${audioExt}`, audio.dataUrl));
  }

  writes.push(downloadFile(`${folder}/log.txt`, toDataUrl("text/plain", renderLog(meta, events))));
  writes.push(downloadFile(`${folder}/events.jsonl`, toDataUrl("application/jsonl", events.map((e) => JSON.stringify(e)).join("\n") + "\n")));
  writes.push(downloadFile(`${folder}/session.json`, toDataUrl("application/json", JSON.stringify(meta, null, 2))));

  const ids = await Promise.all(writes);

  const lastAudio = meta.audio;
  session = null;
  await chrome.storage.session.remove(SESSION_KEY);
  await closeOffscreen();

  const last = {
    id: meta.id,
    folder,
    durationMs: meta.durationMs,
    events: meta.events,
    audio: lastAudio,
    downloadId: ids.find(Boolean) || null
  };
  await chrome.storage.local.set({ [LAST_KEY]: last });

  return { ok: true, last };
}

function toDataUrl(mime, text) {
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
  lines.push(`WalkieTalkie session ${meta.id}`);
  lines.push(`started: ${startedAt}`);
  lines.push(`stopped: ${stoppedAt}`);
  lines.push(`duration: ${fmtClock(meta.durationMs)}`);
  lines.push(`events: ${meta.events}`);
  if (meta.audio?.ok) {
    lines.push(`audio: ${meta.audio.mime || "?"}, ${Math.round((meta.audio.bytes || 0) / 1024)} KB`);
  } else {
    lines.push(`audio: missing (${meta.audio?.error || "unknown"})`);
  }
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
          audio: session?.audio || null,
          last
        });
      })();
      return true;
    case "popup:open-mic-setup":
      chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") });
      sendResponse({ ok: true });
      return false;
    case "setup:granted":
      // Clear the stale mic warning from the last failed session so the
      // popup stops showing it after the user actually granted access.
      // The session.json + log.txt on disk keep the historical truth.
      (async () => {
        const stored = await chrome.storage.local.get(LAST_KEY);
        const last = stored[LAST_KEY];
        if (last && last.audio && last.audio.ok === false) {
          last.audio = { ok: null, error: null, mime: null, bytes: 0 };
          await chrome.storage.local.set({ [LAST_KEY]: last });
        }
      })();
      sendResponse({ ok: true });
      return false;
    case "offscreen:ready":
      if (offscreenReadyResolver) offscreenReadyResolver();
      offscreenReadyResolver = null;
      return false;
    case "audio:level":
      if (session) broadcastLevel(message.level);
      return false;
    case "content:event":
      if (session) session.events.push(message.event);
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

chrome.runtime.onInstalled.addListener(async () => {
  chrome.storage.session.remove(SESSION_KEY).catch(() => {});

  // Reloading an unpacked extension orphans every existing tab's content
  // script — they keep running in the old, now-dead isolated world and
  // can no longer receive messages from this fresh service worker. The
  // manifest's content_scripts entry only auto-injects on subsequent
  // navigations, so without this re-injection users had to reload every
  // tab before recording would work. Inject once on install/update and
  // the IIFE's __walkietalkie_attached__ guard prevents duplicates.
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      if (!/^https?:|^file:/.test(tab.url)) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: false },
        files: ["content.js"]
      }).catch(() => {});
    }
  } catch {}
});
