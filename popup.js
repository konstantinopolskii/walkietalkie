/* TalkTrack — popup controller. */

const recorder = document.getElementById("recorder");
const startBtn = document.getElementById("start");
const stopBtn = document.getElementById("stop");
const elapsed = document.getElementById("elapsed");
const sessionCard = document.getElementById("session");
const sessionSummary = document.getElementById("session-summary");
const sessionPath = document.getElementById("session-path");
const copyBtn = document.getElementById("copy-path");

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

function renderLast(last) {
  if (!last) {
    sessionCard.hidden = true;
    return;
  }
  sessionCard.hidden = false;
  sessionSummary.textContent = `${fmtDuration(last.durationMs)} · ${last.events} events captured.`;
  sessionPath.textContent = `cd ~/Downloads/${last.folder}`;
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
  const text = sessionPath.textContent;
  try {
    await navigator.clipboard.writeText(text);
    const original = copyBtn.textContent;
    copyBtn.textContent = "Copied";
    setTimeout(() => { copyBtn.textContent = original; }, 1200);
  } catch {}
});

refresh();
