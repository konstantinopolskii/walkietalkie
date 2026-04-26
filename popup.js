/* TalkTrack — popup controller. */

const recorder = document.getElementById("recorder");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const elapsed = document.getElementById("elapsed");
const sessionCard = document.getElementById("session");
const sessionBriefing = document.getElementById("session-briefing");
const copyBtn = document.getElementById("copy-briefing");

let timerHandle = null;

function setMode(mode) {
  recorder.dataset.mode = mode;
  document.querySelectorAll("[data-mode-show]").forEach((el) => {
    el.hidden = el.dataset.modeShow !== mode;
  });
}

function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function startTimer(startedAt) {
  stopTimer();
  const tick = () => {
    elapsed.textContent = fmtClock(Date.now() - startedAt);
  };
  tick();
  timerHandle = setInterval(tick, 250);
}

function stopTimer() {
  if (timerHandle) clearInterval(timerHandle);
  timerHandle = null;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} sec` : `${m} min`;
}

function buildBriefing(last) {
  return [
    `TalkTrack session ${last.id}`,
    `folder: ~/Downloads/${last.folder}`,
    `duration: ${fmtDuration(last.durationMs)}, ${last.events} events`,
    `files:`,
    `  audio.webm    microphone capture, opus in webm`,
    `  log.txt       human-readable timeline of clicks, selections, keys`,
    `  events.jsonl  same events, one JSON object per line`,
    `  session.json  metadata: started, stopped, duration, user agent`,
    ``,
    `Read log.txt first for the timeline. Match timestamps in events.jsonl`,
    `for full DOM context (selector, bbox, attrs) on any moment.`
  ].join("\n");
}

function renderLast(last) {
  if (!last) {
    sessionCard.hidden = true;
    return;
  }
  sessionCard.hidden = false;
  sessionBriefing.textContent = buildBriefing(last);
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ target: "background", type: "popup:state" });
  if (state.recording) {
    setMode("recording");
    startTimer(state.startedAt);
  } else {
    setMode("idle");
    stopTimer();
  }
  renderLast(state.last);
}

startBtn.addEventListener("click", async () => {
  startBtn.disabled = true;
  const res = await chrome.runtime.sendMessage({ target: "background", type: "popup:start" });
  startBtn.disabled = false;
  if (res?.ok) {
    setMode("recording");
    startTimer(res.startedAt);
  }
});

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  const res = await chrome.runtime.sendMessage({ target: "background", type: "popup:stop" });
  stopBtn.disabled = false;
  if (res?.ok) {
    setMode("idle");
    stopTimer();
    renderLast(res.last);
  }
});

copyBtn.addEventListener("click", async () => {
  const text = sessionBriefing.textContent;
  try {
    await navigator.clipboard.writeText(text);
    const original = copyBtn.textContent;
    copyBtn.textContent = "Copied";
    setTimeout(() => { copyBtn.textContent = original; }, 1200);
  } catch {}
});

refresh();
