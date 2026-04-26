/* TalkTrack — offscreen audio recorder.
 *
 * MV3 service workers can't hold a MediaRecorder. We run one here in a
 * lifetime-pinned offscreen document for the duration of a session. */

let recorder = null;
let stream = null;
let chunks = [];
let mime = "audio/webm";

function pickMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4"
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

async function start() {
  if (recorder) return { ok: false, reason: "already-running" };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    return { ok: false, reason: "mic-denied", error: String(e && e.message || e) };
  }
  chunks = [];
  const picked = pickMime();
  mime = picked || "audio/webm";
  const opts = picked ? { mimeType: picked } : undefined;
  recorder = new MediaRecorder(stream, opts);
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  });
  recorder.start(1000);
  return { ok: true, mime };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => resolve(r.result);
    r.readAsDataURL(blob);
  });
}

async function stop() {
  if (!recorder) return { ok: false, reason: "not-running" };
  const finished = new Promise((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  recorder.stop();
  await finished;
  for (const track of stream.getTracks()) track.stop();
  const blob = new Blob(chunks, { type: mime });
  const dataUrl = await blobToDataUrl(blob);
  const ext = mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : mime.includes("mp4") ? "m4a" : "bin";
  recorder = null;
  stream = null;
  chunks = [];
  return { ok: true, dataUrl, ext, bytes: blob.size, mime };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  if (msg.type === "start") {
    start().then(sendResponse);
    return true;
  }
  if (msg.type === "stop") {
    stop().then(sendResponse);
    return true;
  }
  return false;
});
