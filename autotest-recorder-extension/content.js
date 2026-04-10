
const STATE = {
  recording: false,
  playing: false,
  lastInputBySelector: new Map(),
  lastEnterAtBySelector: new Map(),
  cancelPlayback: false,
  highlightEl: null
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function setRecordingPersisted(recording) {
  await chrome.storage.local.set({ recording: Boolean(recording) });
}

function isEditable(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "textarea") return true;
  if (tag !== "input") return false;
  const t = (el.getAttribute("type") || "text").toLowerCase();
  return !["button", "submit", "reset", "checkbox", "radio", "file", "image", "hidden"].includes(t);
}

function getEditableFromEvent(ev) {
  if (!ev) return null;
  const path = typeof ev.composedPath === "function" ? ev.composedPath() : [];
  for (const n of path) {
    if (n instanceof Element && isEditable(n)) return n;
  }
  const t = ev.target instanceof Element ? ev.target : null;
  if (!t) return null;
  if (isEditable(t)) return t;
  const closest = t.closest?.('input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable]');
  return closest && isEditable(closest) ? closest : null;
}

function escapeCssIdent(s) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`);
}

function cssPath(el) {
  if (!(el instanceof Element)) return null;
  if (el.id) return `#${escapeCssIdent(el.id)}`;

  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
    const tag = cur.tagName.toLowerCase();
    let part = tag;

    if (cur.classList && cur.classList.length) {
      const cls = Array.from(cur.classList).slice(0, 2).map(escapeCssIdent);
      if (cls.length) part += `.${cls.join(".")}`;
    }

    const parent = cur.parentElement;
    if (parent) {
      const siblingsSameTag = Array.from(parent.children).filter(
        (c) => c.tagName && c.tagName.toLowerCase() === tag
      );
      if (siblingsSameTag.length > 1) {
        const idx = siblingsSameTag.indexOf(cur) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }

    parts.unshift(part);
    cur = parent;
  }

  return parts.length ? parts.join(" > ") : null;
}

function describeEl(el) {
  if (!(el instanceof Element)) return "";
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const name = el.getAttribute("name") ? `[name="${el.getAttribute("name")}"]` : "";
  const text = (el.textContent || "").trim().slice(0, 30);
  const t = text ? ` "${text}"` : "";
  return `${tag}${id}${name}${t}`.trim();
}

async function loadSteps() {
  const { steps = [] } = await chrome.storage.local.get({ steps: [] });
  return Array.isArray(steps) ? steps : [];
}

async function saveSteps(steps) {
  await chrome.storage.local.set({ steps });
  chrome.runtime.sendMessage({ type: "STEPS_UPDATED", stepsCount: steps.length });
}

async function appendStep(step) {
  const steps = await loadSteps();
  steps.push(step);
  await saveSteps(steps);
}

function buildStepBase(el) {
  const selector = cssPath(el);
  return {
    origin: location.origin,
    url: location.href,
    selector,
    ts: Date.now(),
    describe: describeEl(el)
  };
}

function readEditableValue(el) {
  if (!el) return "";
  if ("value" in el) return el.value ?? "";
  if (el.isContentEditable) return el.textContent ?? "";
  return "";
}

function recordInputFromEl(el, { force } = { force: false }) {
  if (!STATE.recording) return;
  if (!el || !isEditable(el)) return;
  const base = buildStepBase(el);
  if (!base.selector) return;

  const value = readEditableValue(el);
  const last = STATE.lastInputBySelector.get(base.selector);

  if (!force && last === value) return;
  STATE.lastInputBySelector.set(base.selector, value);

  appendStep({ ...base, action: "input", value });
}

function recordEnterFromEl(el) {
  if (!STATE.recording) return;
  if (!el || !isEditable(el)) return;
  const base = buildStepBase(el);
  if (!base.selector) return;

  const now = Date.now();
  const last = STATE.lastEnterAtBySelector.get(base.selector) || 0;
  if (now - last < 350) return;
  STATE.lastEnterAtBySelector.set(base.selector, now);

  appendStep({ ...base, action: "enter" });
}

function ensureHighlight() {
  if (STATE.highlightEl) return STATE.highlightEl;
  const el = document.createElement("div");
  el.style.position = "fixed";
  el.style.zIndex = "2147483647";
  el.style.pointerEvents = "none";
  el.style.border = "2px solid #7c3aed";
  el.style.boxShadow = "0 0 0 2px rgba(124,58,237,0.2)";
  el.style.borderRadius = "6px";
  el.style.background = "rgba(124,58,237,0.06)";
  el.style.display = "none";
  document.documentElement.appendChild(el);
  STATE.highlightEl = el;
  return el;
}

function highlightTarget(target) {
  const overlay = ensureHighlight();
  if (!(target instanceof Element)) {
    overlay.style.display = "none";
    return;
  }
  const r = target.getBoundingClientRect();
  overlay.style.left = `${Math.max(0, r.left)}px`;
  overlay.style.top = `${Math.max(0, r.top)}px`;
  overlay.style.width = `${Math.max(0, r.width)}px`;
  overlay.style.height = `${Math.max(0, r.height)}px`;
  overlay.style.display = "block";
}

async function playSteps(steps, opts) {
  if (STATE.playing) return { ok: false, error: "已经在回放中" };
  STATE.playing = true;
  STATE.cancelPlayback = false;

  const {
    stepDelayMs = 250,
    strictOrigin = true,
    notFoundRetryIntervalMs = 10_000,
    notFoundMaxRetries = 5
  } = opts || {};

  try {
    for (let i = 0; i < steps.length; i++) {
      if (STATE.cancelPlayback) return { ok: false, error: "已停止测试" };
      const step = steps[i];

      if (strictOrigin && step.origin && step.origin !== location.origin) {
        const max = Math.max(1, Number(notFoundMaxRetries) || 1);
        const interval = Math.max(0, Number(notFoundRetryIntervalMs) || 0);

        for (let attempt = 1; attempt <= max; attempt++) {
          if (STATE.cancelPlayback) return { ok: false, error: "已停止测试" };
          if (location.origin === step.origin) break;
          if (attempt < max) {
            const endAt = Date.now() + interval;
            while (Date.now() < endAt) {
              if (STATE.cancelPlayback) return { ok: false, error: "已停止测试" };
              if (location.origin === step.origin) break;
              await sleep(Math.min(250, endAt - Date.now()));
            }
          }
        }

        if (location.origin !== step.origin) {
          return {
            ok: false,
            error: `域名不匹配：第 ${i + 1} 步记录域名为 ${step.origin}，当前为 ${location.origin}。已每隔 ${Math.round(
              interval / 1000
            )} 秒重试 ${max} 次仍失败。`
          };
        }
      }

      let el = null;
      const max = Math.max(1, Number(notFoundMaxRetries) || 1);
      const interval = Math.max(0, Number(notFoundRetryIntervalMs) || 0);
      for (let attempt = 1; attempt <= max; attempt++) {
        if (STATE.cancelPlayback) return { ok: false, error: "已停止测试" };
        if (step.selector) el = document.querySelector(step.selector);
        if (el) break;
        if (attempt < max) {
          const endAt = Date.now() + interval;
          while (Date.now() < endAt) {
            if (STATE.cancelPlayback) return { ok: false, error: "已停止测试" };
            await sleep(Math.min(250, endAt - Date.now()));
          }
        }
      }

      if (!el) {
        return {
          ok: false,
          error: `找不到元素：第 ${i + 1} 步（${step.describe || step.selector || "unknown"}）。已每隔 ${Math.round(
            interval / 1000
          )} 秒重试 ${max} 次仍失败。`
        };
      }

      el.scrollIntoView({ block: "center", inline: "center" });
      highlightTarget(el);

      if (step.action === "click") {
        el.click();
      } else if (step.action === "input") {
        if (!isEditable(el)) {
          return { ok: false, error: `元素不是可输入类型：第 ${i + 1} 步（${step.describe || step.selector}）` };
        }
        el.focus();
        const value = step.value ?? "";
        if ("value" in el) {
          el.value = value;
        } else if (el.isContentEditable) {
          el.textContent = value;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (step.action === "enter") {
        if (!isEditable(el)) {
          return { ok: false, error: `元素不是可输入类型：第 ${i + 1} 步（${step.describe || step.selector}）` };
        }
        el.focus();
        const evInit = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        el.dispatchEvent(new KeyboardEvent("keydown", evInit));
        el.dispatchEvent(new KeyboardEvent("keypress", evInit));
        el.dispatchEvent(new KeyboardEvent("keyup", evInit));

        const form = el.closest?.("form");
        if (form) {
          if (typeof form.requestSubmit === "function") form.requestSubmit();
          else form.submit();
        }
      } else {
        return { ok: false, error: `未知动作：第 ${i + 1} 步（${String(step.action)}）` };
      }

      chrome.runtime.sendMessage({ type: "PLAYBACK_PROGRESS", index: i, total: steps.length });
      const endAt = Date.now() + stepDelayMs;
      while (Date.now() < endAt) {
        if (STATE.cancelPlayback) return { ok: false, error: "已停止测试" };
        await sleep(Math.min(60, endAt - Date.now()));
      }
    }

    return { ok: true };
  } finally {
    highlightTarget(null);
    STATE.playing = false;
    STATE.cancelPlayback = false;
  }
}

function onClickCapture(ev) {
  if (!STATE.recording) return;
  const el = ev.target instanceof Element ? ev.target : null;
  if (!el) return;

  if (isEditable(el)) return;

  // 支持最常见的新页面场景：点击 <a target="_blank"> 打开新标签页
  const link = el.closest?.("a[href]");
  if (link) {
    const target = (link.getAttribute("target") || "").toLowerCase();
    if (target === "_blank") {
      const href = link.getAttribute("href");
      if (href) {
        const base = buildStepBase(link);
        const absUrl = new URL(href, location.href).toString();
        appendStep({ ...base, action: "openTab", openUrl: absUrl });
        return;
      }
    }
  }

  const base = buildStepBase(el);
  if (!base.selector) return;
  appendStep({ ...base, action: "click" });
}

function onInputCapture(ev) {
  if (!STATE.recording) return;
  const el = getEditableFromEvent(ev);
  if (!el) return;
  recordInputFromEl(el, { force: false });
}

function onChangeCapture(ev) {
  if (!STATE.recording) return;
  const el = getEditableFromEvent(ev);
  if (!el) return;
  recordInputFromEl(el, { force: true });
}

function onKeydownCapture(ev) {
  if (!STATE.recording) return;
  const el = getEditableFromEvent(ev);
  if (!el) return;

  if (ev.key === "Enter") {
    // 回车可能触发表单提交/页面跳转；强制记录一次最新值
    recordInputFromEl(el, { force: true });
    recordEnterFromEl(el);
  }
}

function onKeyupCapture(ev) {
  if (!STATE.recording) return;
  const el = getEditableFromEvent(ev);
  if (!el) return;
  if (ev.key === "Enter") recordInputFromEl(el, { force: true });
}

function onSubmitCapture(ev) {
  if (!STATE.recording) return;
  const t = ev.target instanceof Element ? ev.target : null;
  if (!t) return;
  // 表单提交前，尽量捕获当前焦点输入框的最终值
  const ae = document.activeElement instanceof Element ? document.activeElement : null;
  if (ae && isEditable(ae)) recordInputFromEl(ae, { force: true });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "SET_RECORDING") {
    (async () => {
      STATE.recording = Boolean(msg.recording);
      await setRecordingPersisted(STATE.recording);
      if (!STATE.recording) {
        STATE.lastInputBySelector.clear();
        STATE.lastEnterAtBySelector.clear();
      }
      sendResponse({ ok: true, recording: STATE.recording });
    })();
    return true;
  }

  if (msg.type === "GET_STATUS") {
    sendResponse({ ok: true, recording: STATE.recording, playing: STATE.playing, origin: location.origin });
    return true;
  }

  if (msg.type === "STOP_PLAYBACK") {
    STATE.cancelPlayback = true;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "PLAY_STEPS") {
    (async () => {
      try {
        const steps = Array.isArray(msg.steps) ? msg.steps : [];
        const res = await playSteps(steps, msg.options || {});
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.recording) {
    STATE.recording = Boolean(changes.recording.newValue);
    if (!STATE.recording) {
      STATE.lastInputBySelector.clear();
      STATE.lastEnterAtBySelector.clear();
    }
  }
});

document.addEventListener("click", onClickCapture, true);
document.addEventListener("input", onInputCapture, true);
document.addEventListener("change", onChangeCapture, true);
document.addEventListener("keydown", onKeydownCapture, true);
document.addEventListener("keyup", onKeyupCapture, true);
document.addEventListener("submit", onSubmitCapture, true);

// 页面跳转/刷新后自动恢复录制状态（直到用户在弹窗点“停止录制”）
(async () => {
  const { recording = false } = await chrome.storage.local.get({ recording: false });
  STATE.recording = Boolean(recording);
})();

