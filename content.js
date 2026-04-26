/* TalkTrack — content script.
 *
 * Listens to page interactions while a session is recording and forwards
 * structured events back to the background service worker. Stays silent
 * when no session is active. */

(() => {
  if (window.__talktrack_attached__) return;
  window.__talktrack_attached__ = true;

  let recording = false;
  let startedAt = 0;
  let indicator = null;

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

  function onClick(e) {
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
  }

  function onKeyDown(e) {
    const isCombo = e.ctrlKey || e.metaKey || e.altKey;
    const isText = e.target && /^(INPUT|TEXTAREA)$/.test(e.target.nodeName);
    if (!isCombo && !["Enter", "Escape", "Tab"].includes(e.key) && !isText) return;
    const d = describe(e.target) || {};
    send({
      kind: "key",
      t: now(),
      url: location.href,
      key: [e.ctrlKey ? "Ctrl" : "", e.metaKey ? "Meta" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", e.key].filter(Boolean).join("+"),
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
    }, 300);
  }

  function onInput(e) {
    if (!e.target || !/^(INPUT|TEXTAREA)$/.test(e.target.nodeName)) return;
    const d = describe(e.target);
    if (!d) return;
    send({
      kind: "input",
      t: now(),
      url: location.href,
      value: clip(e.target.value || "", MAX_TEXT),
      ...d
    });
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

  function showIndicator() {
    if (indicator) return;
    indicator = document.createElement("div");
    indicator.id = "talktrack-indicator";
    Object.assign(indicator.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      width: "12px",
      height: "12px",
      borderRadius: "50%",
      background: "#e21b1b",
      boxShadow: "0 0 0 4px rgba(226, 27, 27, 0.18)",
      zIndex: "2147483647",
      pointerEvents: "none",
      animation: "talktrack-pulse 1.4s ease-in-out infinite"
    });
    const style = document.createElement("style");
    style.textContent = `@keyframes talktrack-pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.18); opacity: 0.6; } }`;
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(indicator);
  }

  function hideIndicator() {
    if (!indicator) return;
    indicator.remove();
    indicator = null;
  }

  function attach() {
    document.addEventListener("click", onClick, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("selectionchange", onSelectionChange, true);
    document.addEventListener("input", onInput, true);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("visibilitychange", onVisibility, true);
  }

  function detach() {
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("contextmenu", onContextMenu, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("selectionchange", onSelectionChange, true);
    document.removeEventListener("input", onInput, true);
    window.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("visibilitychange", onVisibility, true);
  }

  function start(t) {
    if (recording) return;
    recording = true;
    startedAt = t || Date.now();
    attach();
    showIndicator();
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
    hideIndicator();
    recording = false;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.target !== "content") return;
    if (msg.type === "start") start(msg.startedAt);
    else if (msg.type === "stop") stop();
  });

  // Late attach: if a session is already running when this script loads
  // (e.g., user opened a new tab mid-session), ask the background.
  chrome.runtime.sendMessage({ target: "background", type: "content:hello" }).then((res) => {
    if (res && res.recording) start(res.startedAt);
  }).catch(() => {});
})();
