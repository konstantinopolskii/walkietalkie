/* WalkieTalkie — content script.
 *
 * Listens to page interactions while a session is recording and forwards
 * structured events back to the background service worker. Stays silent
 * when no session is active. */

(() => {
  if (window.__walkietalkie_attached__) return;
  window.__walkietalkie_attached__ = true;

  let recording = false;
  let startedAt = 0;

  let overlayHost = null;
  let overlayShadow = null;
  let waveCanvas = null;
  let waveCtx = null;
  let waveRaf = null;
  const LEVEL_BARS = 12;
  const levelSamples = []; // rolling buffer of recent RMS values

  let highlightedEl = null;
  let highlightOverlay = null;

  const MAX_TEXT = 160;

  function send(event) {
    if (!recording) return;
    chrome.runtime.sendMessage({ target: "background", type: "content:event", event }).catch(() => {});
  }

  function now() {
    return Date.now() - startedAt;
  }

  function clip(s, n = MAX_TEXT) {
    if (s == null) return "";
    s = String(s).replace(/\s+/g, " ").trim();
    if (s.length <= n) return s;
    return s.slice(0, n - 1) + "…";
  }

  function selectorFor(el) {
    if (!(el instanceof Element)) return "";
    if (el.id) return `#${cssEscape(el.id)}`;
    const path = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let part = cur.nodeName.toLowerCase();
      if (cur.id) {
        path.unshift(`${part}#${cssEscape(cur.id)}`);
        break;
      }
      if (cur.classList && cur.classList.length) {
        const cls = Array.from(cur.classList).slice(0, 3).map(cssEscape).join(".");
        if (cls) part += `.${cls}`;
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((s) => s.nodeName === cur.nodeName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          part += `:nth-of-type(${idx})`;
        }
      }
      path.unshift(part);
      cur = parent;
      depth++;
    }
    return path.join(" > ");
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function describe(el) {
    if (!(el instanceof Element)) return null;
    const rect = el.getBoundingClientRect();
    const attrs = {};
    for (const name of ["role", "type", "name", "href", "value", "placeholder", "aria-label", "aria-labelledby", "data-testid"]) {
      const v = el.getAttribute(name);
      if (v) attrs[name] = clip(v, 120);
    }
    const tag = el.nodeName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList.length ? "." + Array.from(el.classList).slice(0, 3).join(".") : "";
    const labelText = clip(el.innerText || el.textContent || el.value || attrs["aria-label"] || "", 60);
    return {
      label: `${tag}${id}${cls}${labelText ? ` "${labelText}"` : ""}`,
      selector: selectorFor(el),
      text: clip(el.innerText || el.textContent || "", MAX_TEXT),
      bbox: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      attrs
    };
  }

  function viewport() {
    return {
      w: window.innerWidth,
      h: window.innerHeight,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY)
    };
  }

  function shortTagFor(el) {
    if (!(el instanceof Element)) return "";
    const tag = el.nodeName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.classList && el.classList.length
      ? "." + Array.from(el.classList).slice(0, 2).join(".")
      : "";
    return `${tag}${id}${cls}`;
  }

  function setOverlayLabel(tag, text) {
    if (!overlayShadow) return;
    const tagEl = overlayShadow.querySelector(".tag");
    const textEl = overlayShadow.querySelector(".text");
    if (tagEl) tagEl.textContent = tag || "—";
    if (textEl) textEl.textContent = text || "";
  }

  function isOurOverlay(el) {
    // Clicks inside the shadow DOM retarget to the host outside the boundary.
    return el && el.id === "walkietalkie-overlay-host";
  }

  function paintHighlight(el) {
    if (!highlightOverlay) {
      highlightOverlay = document.createElement("div");
      Object.assign(highlightOverlay.style, {
        position: "fixed",
        pointerEvents: "none",
        zIndex: "2147483646",
        boxShadow: "0 0 0 2px #ffffff, 0 0 0 4px #000000",
        borderRadius: "3px",
        transition: "top 80ms ease-out, left 80ms ease-out, width 80ms ease-out, height 80ms ease-out",
        boxSizing: "border-box"
      });
      document.documentElement.appendChild(highlightOverlay);
    }
    highlightedEl = el;
    repositionHighlight();
  }

  function repositionHighlight() {
    if (!highlightedEl || !highlightOverlay) return;
    if (!document.contains(highlightedEl)) {
      clearHighlight();
      return;
    }
    const rect = highlightedEl.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      clearHighlight();
      return;
    }
    Object.assign(highlightOverlay.style, {
      top: rect.top + "px",
      left: rect.left + "px",
      width: rect.width + "px",
      height: rect.height + "px"
    });
  }

  function clearHighlight() {
    if (highlightOverlay) {
      highlightOverlay.remove();
      highlightOverlay = null;
    }
    highlightedEl = null;
  }

  function onClick(e) {
    // Our own floating overlay (stop button etc.) — let through, don't log
    // a regular click event for it; the stop button has its own wiring.
    if (isOurOverlay(e.target)) return;

    if (highlightedEl) {
      // A highlight is up — this click commits, no matter the target.
      // Clear the border and let the page handle the click. Targeting the
      // exact same DOM node twice was unreliable (nested children changed
      // e.target between clicks), so any next click acts.
      clearHighlight();
      const d = describe(e.target);
      if (!d) return;
      send({
        kind: "click",
        t: now(),
        url: location.href,
        title: document.title,
        mouse: { x: Math.round(e.clientX), y: Math.round(e.clientY), button: e.button },
        viewport: viewport(),
        ...d
      });
      setOverlayLabel(shortTagFor(e.target), clip(d.text, 60));
      return;
    }

    // No highlight yet — first click. Suppress the page's own action,
    // paint the highlight, log a "highlight" event. The next click
    // commits via the branch above.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    paintHighlight(e.target);
    const d = describe(e.target);
    if (!d) return;
    send({
      kind: "highlight",
      t: now(),
      url: location.href,
      title: document.title,
      mouse: { x: Math.round(e.clientX), y: Math.round(e.clientY), button: e.button },
      viewport: viewport(),
      ...d
    });
    setOverlayLabel(shortTagFor(e.target), clip(d.text, 60));
  }

  function onMouseDownCapture(e) {
    // Suppress mousedown only while there's no active highlight, so apps
    // that fire on mousedown (React/Vue delegated handlers) can't sneak
    // past on the first click. Once a highlight is up, the next click
    // commits — so let mousedown through too.
    if (isOurOverlay(e.target)) return;
    if (highlightedEl) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onMouseUpCapture(e) {
    if (isOurOverlay(e.target)) return;
    if (highlightedEl) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onWindowScrollOrResize() {
    repositionHighlight();
  }

  function onEscape(e) {
    if (e.key === "Escape" && highlightedEl) {
      clearHighlight();
    }
  }

  function onContextMenu(e) {
    const d = describe(e.target);
    if (!d) return;
    send({
      kind: "context-menu",
      t: now(),
      url: location.href,
      mouse: { x: Math.round(e.clientX), y: Math.round(e.clientY) },
      viewport: viewport(),
      ...d
    });
    setOverlayLabel(shortTagFor(e.target), clip(d.text, 60));
  }

  function onKeyDown(e) {
    const isCombo = e.ctrlKey || e.metaKey || e.altKey;
    const isText = e.target && /^(INPUT|TEXTAREA)$/.test(e.target.nodeName);
    if (!isCombo && !["Enter", "Escape", "Tab"].includes(e.key) && !isText) return;
    const d = describe(e.target) || {};
    const mods = [];
    if (e.ctrlKey && e.key !== "Control") mods.push("Ctrl");
    if (e.metaKey && e.key !== "Meta") mods.push("Meta");
    if (e.altKey && e.key !== "Alt") mods.push("Alt");
    if (e.shiftKey && e.key !== "Shift") mods.push("Shift");
    send({
      kind: "key",
      t: now(),
      url: location.href,
      key: mods.concat([e.key]).join("+"),
      ...d
    });
  }

  let selectionTimer = null;
  function onSelectionChange() {
    if (selectionTimer) clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const text = clip(sel.toString(), MAX_TEXT);
      if (!text) return;
      const anchor = sel.anchorNode && sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
      const d = anchor ? describe(anchor) : {};
      send({
        kind: "selection",
        t: now(),
        url: location.href,
        value: text,
        viewport: viewport(),
        ...d
      });
      if (anchor) setOverlayLabel(shortTagFor(anchor), `selected: ${clip(text, 50)}`);
    }, 300);
  }

  function onInput(e) {
    if (!e.target || !/^(INPUT|TEXTAREA)$/.test(e.target.nodeName)) return;
    const d = describe(e.target);
    if (!d) return;
    const value = clip(e.target.value || "", MAX_TEXT);
    send({
      kind: "input",
      t: now(),
      url: location.href,
      value,
      ...d
    });
    setOverlayLabel(shortTagFor(e.target), value ? `typed: ${clip(value, 50)}` : "(empty)");
  }

  let scrollTimer = null;
  function onScroll() {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      send({
        kind: "scroll",
        t: now(),
        url: location.href,
        viewport: viewport()
      });
    }, 250);
  }

  function onVisibility() {
    send({
      kind: "visibility",
      t: now(),
      url: location.href,
      value: document.visibilityState
    });
  }

  function showOverlay() {
    if (overlayHost) return;
    overlayHost = document.createElement("div");
    overlayHost.id = "walkietalkie-overlay-host";
    Object.assign(overlayHost.style, {
      position: "fixed",
      left: "50%",
      bottom: "20px",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      pointerEvents: "none",
      width: "300px",
      height: "46px"
    });
    overlayShadow = overlayHost.attachShadow({ mode: "open" });
    overlayShadow.innerHTML = `
      <style>
        :host, * { box-sizing: border-box; margin: 0; padding: 0; }
        .overlay {
          width: 300px;
          height: 46px;
          border-radius: 12px;
          background: rgba(0, 0, 0, 0.78);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          color: #fff;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 0 10px 0 12px;
          font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", system-ui, sans-serif;
          font-feature-settings: "tnum" 1;
          animation: wt-fade 160ms ease-out;
        }
        @keyframes wt-fade {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        canvas { width: 64px; height: 26px; flex: 0 0 auto; }
        .label {
          display: flex;
          flex-direction: column;
          min-width: 0;
          flex: 1 1 auto;
          line-height: 1.25;
          gap: 2px;
        }
        .tag {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: -0.01em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .text {
          font-size: 10px;
          opacity: 0.62;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .stop {
          flex: 0 0 auto;
          width: 26px;
          height: 26px;
          border: 0;
          padding: 0;
          margin: 0;
          border-radius: 7px;
          background: rgba(255, 255, 255, 0.14);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          pointer-events: auto;
          transition: background 120ms ease-out, transform 120ms ease-out;
          font: inherit;
        }
        .stop:hover { background: rgba(255, 255, 255, 0.24); }
        .stop:active { transform: scale(0.94); background: rgba(255, 255, 255, 0.32); }
        .stop:focus-visible { outline: 2px solid rgba(255, 255, 255, 0.5); outline-offset: 2px; }
        .stop-icon {
          width: 10px;
          height: 10px;
          background: #fff;
          border-radius: 2px;
          display: block;
        }
      </style>
      <div class="overlay" role="status" aria-label="WalkieTalkie recording">
        <canvas></canvas>
        <div class="label">
          <span class="tag">Recording</span>
          <span class="text"></span>
        </div>
        <button class="stop" type="button" aria-label="Stop recording" title="Stop recording">
          <span class="stop-icon"></span>
        </button>
      </div>
    `;
    document.documentElement.appendChild(overlayHost);

    waveCanvas = overlayShadow.querySelector("canvas");
    const dpr = window.devicePixelRatio || 1;
    waveCanvas.width = 64 * dpr;
    waveCanvas.height = 26 * dpr;
    waveCtx = waveCanvas.getContext("2d");
    waveCtx.scale(dpr, dpr);
    levelSamples.length = 0;

    overlayShadow.querySelector(".stop").addEventListener("click", () => {
      chrome.runtime.sendMessage({ target: "background", type: "popup:stop" }).catch(() => {});
    });

    setOverlayLabel("Recording", clip(document.title || location.host, 60));
    drawWave();
  }

  function destroyOverlay() {
    if (waveRaf) cancelAnimationFrame(waveRaf);
    waveRaf = null;
    waveCtx = null;
    waveCanvas = null;
    levelSamples.length = 0;
    if (overlayHost) overlayHost.remove();
    overlayHost = null;
    overlayShadow = null;
  }

  function pushLevel(v) {
    if (typeof v !== "number" || !isFinite(v)) return;
    levelSamples.push(v);
    if (levelSamples.length > LEVEL_BARS) levelSamples.shift();
  }

  function drawWave() {
    if (!waveCtx) return;
    const W = 64;
    const H = 26;
    waveCtx.clearRect(0, 0, W, H);
    const barW = 3;
    const gap = (W - LEVEL_BARS * barW) / (LEVEL_BARS - 1);
    waveCtx.fillStyle = "rgba(255, 255, 255, 0.92)";
    for (let i = 0; i < LEVEL_BARS; i++) {
      const idx = levelSamples.length - LEVEL_BARS + i;
      const v = idx >= 0 ? levelSamples[idx] : 0;
      // Speech RMS hovers ~0.05–0.25; scale into a usable visual range.
      const punched = Math.min(1, v * 4.5);
      const barH = Math.max(2, punched * H);
      const x = i * (barW + gap);
      const y = (H - barH) / 2;
      // Slight rounded caps via two arcs.
      const r = Math.min(barW / 2, barH / 2);
      waveCtx.beginPath();
      waveCtx.moveTo(x + r, y);
      waveCtx.lineTo(x + barW - r, y);
      waveCtx.arc(x + barW - r, y + r, r, -Math.PI / 2, 0);
      waveCtx.lineTo(x + barW, y + barH - r);
      waveCtx.arc(x + barW - r, y + barH - r, r, 0, Math.PI / 2);
      waveCtx.lineTo(x + r, y + barH);
      waveCtx.arc(x + r, y + barH - r, r, Math.PI / 2, Math.PI);
      waveCtx.lineTo(x, y + r);
      waveCtx.arc(x + r, y + r, r, Math.PI, -Math.PI / 2);
      waveCtx.fill();
    }
    waveRaf = requestAnimationFrame(drawWave);
  }

  function attach() {
    document.addEventListener("mousedown", onMouseDownCapture, true);
    document.addEventListener("mouseup", onMouseUpCapture, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keydown", onEscape, true);
    document.addEventListener("selectionchange", onSelectionChange, true);
    document.addEventListener("input", onInput, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("scroll", onWindowScrollOrResize, true);
    window.addEventListener("resize", onWindowScrollOrResize);
    document.addEventListener("visibilitychange", onVisibility, true);
  }

  function detach() {
    document.removeEventListener("mousedown", onMouseDownCapture, true);
    document.removeEventListener("mouseup", onMouseUpCapture, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keydown", onEscape, true);
    document.removeEventListener("selectionchange", onSelectionChange, true);
    document.removeEventListener("input", onInput, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("scroll", onWindowScrollOrResize, true);
    window.removeEventListener("resize", onWindowScrollOrResize);
    document.removeEventListener("visibilitychange", onVisibility, true);
    clearHighlight();
  }

  function start(t) {
    if (recording) return;
    recording = true;
    startedAt = t || Date.now();
    attach();
    showOverlay();
    send({
      kind: "page",
      t: now(),
      url: location.href,
      title: document.title,
      viewport: viewport()
    });
  }

  function stop() {
    if (!recording) return;
    detach();
    destroyOverlay();
    recording = false;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== "content") return;
    if (msg.type === "start") start(msg.startedAt);
    else if (msg.type === "stop") stop();
    else if (msg.type === "level") pushLevel(msg.level);
  });

  // Late attach: if a session is already running when this script loads
  // (e.g., user opened a new tab mid-session), ask the background.
  chrome.runtime.sendMessage({ target: "background", type: "content:hello" }).then((res) => {
    if (res && res.recording) start(res.startedAt);
  }).catch(() => {});
})();
