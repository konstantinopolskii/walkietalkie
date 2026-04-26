/* WalkieTalkie — offscreen audio recorder.
 *
 * MV3 service workers can't hold a MediaRecorder. We run one here in a
 * lifetime-pinned offscreen document for the duration of a session.
 * Alongside the recorder we run a small AnalyserNode tap on the same
 * stream, sample RMS at ~12 Hz, and broadcast it to background → all
 * host tabs so the in-page overlay can animate a level meter. */

const MIC_DEVICE_KEY = "walkietalkie:mic-device-id";
const LEVEL_INTERVAL_MS = 80;

let recorder = null;
let stream = null;
let chunks = [];
let mime = "audio/webm";

let audioCtx = null;
let analyser = null;
let levelTimer = null;
let levelData = null;

function pickMime() {
  // Prefer mp4/AAC: plays everywhere on macOS, iOS, Windows out of the
  // box (.m4a in QuickTime/Music/WMP). Fall back to webm/opus for browsers
  // that don't ship the AAC encoder.
  const candidates = [
    "audio/mp4",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus"
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

function extFor(m) {
  if (!m) return "bin";
  if (m.includes("mp4")) return "m4a";
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  return "bin";
}

function startLevelLoop() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    levelData = new Uint8Array(analyser.fftSize);
  } catch {
    return;
  }
  levelTimer = setInterval(() => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(levelData);
    let sum = 0;
    for (let i = 0; i < levelData.length; i++) {
      const v = (levelData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / levelData.length);
    chrome.runtime.sendMessage({ target: "background", type: "audio:level", level: rms })
      .catch(() => {});
  }, LEVEL_INTERVAL_MS);
}

function stopLevelLoop() {
  if (levelTimer) clearInterval(levelTimer);
  levelTimer = null;
  analyser = null;
  levelData = null;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
}

async function getDeviceId() {
  try {
    const stored = await chrome.storage.local.get(MIC_DEVICE_KEY);
    return stored[MIC_DEVICE_KEY] || "";
  } catch {
    return "";
  }
}

async function start() {
  if (recorder) return { ok: false, reason: "already-running" };
  const deviceId = await getDeviceId();
  const constraints = deviceId
    ? { audio: { deviceId: { ideal: deviceId } } }
    : { audio: true };
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
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
  startLevelLoop();
  return { ok: true, mime, ext: extFor(mime), deviceId };
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
  stopLevelLoop();
  const finished = new Promise((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  recorder.stop();
  await finished;
  for (const track of stream.getTracks()) track.stop();
  const blob = new Blob(chunks, { type: mime });
  const dataUrl = await blobToDataUrl(blob);
  const ext = extFor(mime);
  recorder = null;
  stream = null;
  chunks = [];
  return { ok: true, dataUrl, ext, bytes: blob.size, mime };
}

async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const mics = all.filter((d) => d.kind === "audioinput").map((d) => ({
      deviceId: d.deviceId,
      label: d.label || `Microphone (${d.deviceId.slice(0, 6)}…)`
    }));
    return { ok: true, devices: mics };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function swap(deviceId) {
  // Recording must be active to swap. If it's not, just save the
  // preference (already done in background) and bail.
  if (!recorder) return { ok: false, reason: "not-running" };
  // Tear the live stream + recorder down without finalizing the file —
  // the user is swapping because there's nothing worth keeping. We
  // restart fresh on the new mic; chunks reset.
  stopLevelLoop();
  try { recorder.ondataavailable = null; } catch {}
  try { recorder.stop(); } catch {}
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
  }
  recorder = null;
  stream = null;
  chunks = [];

  const constraints = deviceId
    ? { audio: { deviceId: { ideal: deviceId } } }
    : { audio: true };
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (e) {
    return { ok: false, reason: "mic-denied", error: String(e?.message || e) };
  }
  const picked = pickMime();
  mime = picked || "audio/webm";
  const opts = picked ? { mimeType: picked } : undefined;
  recorder = new MediaRecorder(stream, opts);
  recorder.addEventListener("dataavailable", (e) => {
    if (e.data && e.data.size) chunks.push(e.data);
  });
  recorder.start(1000);
  startLevelLoop();
  return { ok: true, mime, ext: extFor(mime) };
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
  if (msg.type === "list-devices") {
    listDevices().then(sendResponse);
    return true;
  }
  if (msg.type === "swap") {
    swap(msg.deviceId || "").then(sendResponse);
    return true;
  }
  return false;
});

chrome.runtime.sendMessage({ target: "background", type: "offscreen:ready" }).catch(() => {});
