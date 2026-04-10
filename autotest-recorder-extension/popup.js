/* global chrome */

const els = {
  subStatus: document.getElementById("subStatus"),
  btnStartRec: document.getElementById("btnStartRec"),
  btnStopRec: document.getElementById("btnStopRec"),
  chkNet: document.getElementById("chkNet"),
  pillNetCount: document.getElementById("pillNetCount"),
  pillNetCount2: document.getElementById("pillNetCount2"),
  btnNetClear: document.getElementById("btnNetClear"),
  btnNetExport: document.getElementById("btnNetExport"),
  netList: document.getElementById("netList"),
  btnPlay: document.getElementById("btnPlay"),
  btnStopTest: document.getElementById("btnStopTest"),
  btnClear: document.getElementById("btnClear"),
  btnReset: document.getElementById("btnReset"),
  btnExport: document.getElementById("btnExport"),
  btnImport: document.getElementById("btnImport"),
  fileImport: document.getElementById("fileImport"),
  pillCount: document.getElementById("pillCount"),
  stepsList: document.getElementById("stepsList"),
  errBox: document.getElementById("errBox")
};

let currentSteps = [];
let saveStepsTimer = null;

function setError(msg) {
  if (!msg) {
    els.errBox.hidden = true;
    els.errBox.textContent = "";
    return;
  }
  els.errBox.hidden = false;
  els.errBox.textContent = msg;
}

function fmtAction(step) {
  if (step.action === "click") return "点击";
  if (step.action === "input") return `输入：${JSON.stringify(step.value ?? "")}`;
  if (step.action === "enter") return "回车(Enter)";
  if (step.action === "openTab") return `打开新页：${String(step.openUrl || "")}`;
  return String(step.action || "");
}

function renderSteps(steps) {
  currentSteps = Array.isArray(steps) ? steps : [];
  els.stepsList.innerHTML = "";
  els.pillCount.textContent = String(currentSteps.length);
  currentSteps.forEach((s, idx) => {
    const li = document.createElement("li");

    const btnDel = document.createElement("button");
    btnDel.className = "iconBtn";
    btnDel.type = "button";
    btnDel.textContent = "删除";
    btnDel.addEventListener("click", async () => {
      setError("");
      currentSteps.splice(idx, 1);
      try {
        await setSteps(currentSteps);
      } catch (e) {
        setError(e?.message || String(e));
        return;
      }
      renderSteps(currentSteps);
    });
    li.appendChild(btnDel);

    const head = document.createElement("div");
    head.innerHTML = `<span class="tag">#${idx + 1}</span><span class="tag">${fmtAction(s)}</span>${escapeHtml(
      s.describe || s.selector || ""
    )}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${s.origin || ""}`;
    li.appendChild(head);
    li.appendChild(meta);

    if (s.action === "input") {
      const inp = document.createElement("input");
      inp.className = "editValue";
      inp.type = "text";
      inp.value = String(s.value ?? "");
      inp.placeholder = "编辑输入值（会自动保存）";
      inp.addEventListener("input", () => {
        currentSteps[idx] = { ...currentSteps[idx], value: inp.value };
        scheduleSaveSteps();
      });
      li.appendChild(inp);
    }

    els.stepsList.appendChild(li);
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function getSteps() {
  const { steps = [] } = await chrome.storage.local.get({ steps: [] });
  return Array.isArray(steps) ? steps : [];
}

async function setSteps(steps) {
  await chrome.storage.local.set({ steps });
}

function scheduleSaveSteps() {
  if (saveStepsTimer) clearTimeout(saveStepsTimer);
  saveStepsTimer = setTimeout(async () => {
    try {
      await setSteps(currentSteps);
    } catch (e) {
      setError(e?.message || String(e));
    }
  }, 250);
}

async function getNetworkLogs() {
  const { networkLogs = [] } = await chrome.storage.local.get({ networkLogs: [] });
  return Array.isArray(networkLogs) ? networkLogs : [];
}

function renderNetLogs(logs) {
  const arr = Array.isArray(logs) ? logs : [];
  const cnt = String(arr.length);
  els.pillNetCount.textContent = cnt;
  els.pillNetCount2.textContent = cnt;
  els.netList.innerHTML = "";

  arr.slice(-50).reverse().forEach((l, idx) => {
    const li = document.createElement("li");
    const url = l?.request?.url || l?.response?.url || "";
    const method = l?.request?.method || "";
    const status = l?.response?.status != null ? String(l.response.status) : (l.loadingFailed ? "FAILED" : "");
    const head = document.createElement("div");
    head.innerHTML = `<span class="tag">${escapeHtml(method)}</span><span class="tag">${escapeHtml(
      status
    )}</span>${escapeHtml(url)}`;
    const meta = document.createElement("div");
    meta.className = "meta";
    const hasBody = l?.responseBody?.body != null;
    meta.textContent = `${hasBody ? "包含响应体" : "无响应体/不可获取"}${l?.responseBodyError ? " | " + l.responseBodyError : ""}`;
    li.appendChild(head);
    li.appendChild(meta);
    els.netList.appendChild(li);
  });
}

async function getActiveTab() {
  const res = await chrome.runtime.sendMessage({ type: "GET_ACTIVE_TAB" });
  if (!res?.ok || !res.tabId) return null;
  return res;
}

async function getAllFrames(tabId) {
  return await new Promise((resolve) => {
    chrome.webNavigation.getAllFrames({ tabId }, (frames) => resolve(Array.isArray(frames) ? frames : []));
  });
}

async function sendToFrame(tabId, url, frameId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg.includes("Receiving end does not exist")) {
      await ensureContentScript(tabId, url);
      return await chrome.tabs.sendMessage(tabId, message, { frameId });
    }
    throw e;
  }
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("view-source:") ||
    url.startsWith("file://")
  );
}

async function ensureContentScript(tabId, url) {
  if (isRestrictedUrl(url)) {
    throw new Error("当前页面不支持注入脚本（例如 chrome://、扩展页、file:// 等）。请在普通 http/https 网页上使用。");
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  } catch (e) {
    throw new Error(e?.message || "注入脚本失败");
  }
}

async function sendToTab(tabId, url, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    const msg = e?.message || String(e);
    if (msg.includes("Receiving end does not exist")) {
      await ensureContentScript(tabId, url);
      return await chrome.tabs.sendMessage(tabId, message);
    }
    throw e;
  }
}

async function refreshStatusUI() {
  const active = await getActiveTab();
  if (!active) {
    els.subStatus.textContent = "未找到活动标签页";
    return;
  }

  try {
    const st = await sendToTab(active.tabId, active.url, { type: "GET_STATUS" });
    if (st?.ok) {
      els.subStatus.textContent = `${st.origin || ""} | 录制：${st.recording ? "开" : "关"} | 回放：${
        st.playing ? "进行中" : "空闲"
      }`;
      els.btnStartRec.disabled = Boolean(st.recording) || Boolean(st.playing);
      els.btnStopRec.disabled = !Boolean(st.recording) || Boolean(st.playing);
      els.btnPlay.disabled = Boolean(st.playing);
      els.btnStopTest.disabled = !Boolean(st.playing);
    } else {
      els.subStatus.textContent = `${active.url || ""}`;
    }
  } catch (e) {
    els.subStatus.textContent = `${active.url || ""}`;
    setError(e?.message || "无法连接到页面脚本");
  }
}

async function refreshNetStatusUI() {
  const active = await getActiveTab();
  if (!active) return;
  try {
    const st = await chrome.runtime.sendMessage({ type: "NET_STATUS" });
    if (st?.ok && st.enabled && st.attachedTabId === active.tabId) {
      els.chkNet.checked = true;
      return;
    }
    if (st?.ok && st.enabled && st.attachedTabId && st.attachedTabId !== active.tabId) {
      els.chkNet.checked = false;
      setError("网络记录已在另一个标签页启用：请先在那个标签页关闭，或切换到对应标签页。");
      return;
    }
    els.chkNet.checked = false;
  } catch {
    // ignore
  }
}

els.btnStartRec.addEventListener("click", async () => {
  setError("");
  const active = await getActiveTab();
  if (!active) return;
  try {
    await sendToTab(active.tabId, active.url, { type: "SET_RECORDING", recording: true });
  } catch (e) {
    setError(e?.message || String(e));
  } finally {
    await refreshStatusUI();
  }
});

els.btnStopRec.addEventListener("click", async () => {
  setError("");
  const active = await getActiveTab();
  if (!active) return;
  try {
    await sendToTab(active.tabId, active.url, { type: "SET_RECORDING", recording: false });
  } catch (e) {
    setError(e?.message || String(e));
  } finally {
    await refreshStatusUI();
  }
});

els.btnClear.addEventListener("click", async () => {
  setError("");
  await setSteps([]);
  renderSteps([]);
});

els.chkNet.addEventListener("change", async () => {
  setError("");
  const active = await getActiveTab();
  if (!active) return;
  try {
    if (els.chkNet.checked) {
      const res = await chrome.runtime.sendMessage({ type: "NET_START", tabId: active.tabId });
      if (!res?.ok) throw new Error(res?.error || "开启网络记录失败");
    } else {
      const res = await chrome.runtime.sendMessage({ type: "NET_STOP" });
      if (!res?.ok) throw new Error(res?.error || "关闭网络记录失败");
    }
  } catch (e) {
    setError(e?.message || String(e));
    els.chkNet.checked = false;
  } finally {
    const logs = await getNetworkLogs();
    renderNetLogs(logs);
  }
});

els.btnNetClear.addEventListener("click", async () => {
  setError("");
  await chrome.runtime.sendMessage({ type: "NET_CLEAR_LOGS" });
  renderNetLogs([]);
});

els.btnNetExport.addEventListener("click", async () => {
  setError("");
  const logs = await getNetworkLogs();
  const blob = new Blob([JSON.stringify({ version: 1, networkLogs: logs }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `autotest-network-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

els.btnPlay.addEventListener("click", async () => {
  setError("");
  const steps = await getSteps();
  if (!steps.length) {
    setError("步骤列表为空：请先录制或导入。");
    return;
  }
  let active = await getActiveTab();
  if (!active) return;

  els.btnPlay.disabled = true;
  els.btnStopTest.disabled = false;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // 新标签页：仅支持录制的 openTab（常见 <a target="_blank">）
      if (step.action === "openTab" && step.openUrl) {
        const tab = await chrome.tabs.create({ url: step.openUrl, active: true });
        active = { tabId: tab.id, url: tab.url };
        // 给新页一点加载时间（也可依赖后续重试机制）
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }

      const max = 5;
      const intervalMs = 10_000;
      let lastErr = "";

      for (let attempt = 1; attempt <= max; attempt++) {
        // 每步都刷新一次 frames，适配 iframe 动态创建/导航
        const frames = await getAllFrames(active.tabId);
        const candidates = frames
          .filter((f) => f && typeof f.frameId === "number")
          .filter((f) => {
            try {
              if (!step.origin) return true;
              return new URL(f.url).origin === step.origin;
            } catch {
              return false;
            }
          });

        // 优先 top frame，再尝试其他 frame
        candidates.sort((a, b) => (a.frameId === 0 ? -1 : 0) - (b.frameId === 0 ? -1 : 0));

        let handled = false;
        for (const f of candidates) {
          try {
            const res = await sendToFrame(active.tabId, active.url, f.frameId, {
              type: "PLAY_STEPS",
              steps: [step],
              options: { stepDelayMs: 250, strictOrigin: true, notFoundRetryIntervalMs: 0, notFoundMaxRetries: 1 }
            });
            if (res?.ok) {
              handled = true;
              break;
            }
            lastErr = res?.error || lastErr;
          } catch (e) {
            lastErr = e?.message || String(e);
          }
        }

        if (handled) break;
        if (attempt === max) {
          throw new Error(lastErr || `第 ${i + 1} 步执行失败`);
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    }
  } catch (e) {
    setError(e?.message || String(e));
  } finally {
    els.btnStopTest.disabled = true;
    await refreshStatusUI();
  }
});

els.btnStopTest.addEventListener("click", async () => {
  setError("");
  const active = await getActiveTab();
  if (!active) return;
  try {
    const frames = await getAllFrames(active.tabId);
    await Promise.all(
      frames
        .filter((f) => f && typeof f.frameId === "number")
        .map((f) => sendToFrame(active.tabId, active.url, f.frameId, { type: "STOP_PLAYBACK" }).catch(() => null))
    );
  } catch (e) {
    setError(e?.message || String(e));
  } finally {
    await refreshStatusUI();
  }
});

els.btnReset.addEventListener("click", async () => {
  setError("");
  const active = await getActiveTab();
  if (active) {
    try {
      await sendToTab(active.tabId, active.url, { type: "STOP_PLAYBACK" });
      await sendToTab(active.tabId, active.url, { type: "SET_RECORDING", recording: false });
    } catch (e) {
      setError(e?.message || String(e));
    }
  }

  try {
    await setSteps([]);
    renderSteps([]);
  } catch (e) {
    setError(e?.message || String(e));
  }

  try {
    els.chkNet.checked = false;
    await chrome.runtime.sendMessage({ type: "NET_STOP" });
    await chrome.runtime.sendMessage({ type: "NET_CLEAR_LOGS" });
    renderNetLogs([]);
  } catch (e) {
    setError(e?.message || String(e));
  }

  await refreshStatusUI();
});

els.btnExport.addEventListener("click", async () => {
  setError("");
  const steps = await getSteps();
  const blob = new Blob([JSON.stringify({ version: 1, steps }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `autotest-steps-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

els.btnImport.addEventListener("click", async () => {
  setError("");
  els.fileImport.value = "";
  els.fileImport.click();
});

els.fileImport.addEventListener("change", async () => {
  setError("");
  const f = els.fileImport.files && els.fileImport.files[0];
  if (!f) return;
  try {
    const txt = await f.text();
    const obj = JSON.parse(txt);
    const steps = Array.isArray(obj?.steps) ? obj.steps : [];
    await setSteps(steps);
    renderSteps(steps);
  } catch (e) {
    setError(`导入失败：${e?.message || String(e)}`);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.steps) {
    const next = Array.isArray(changes.steps.newValue) ? changes.steps.newValue : [];
    renderSteps(next);
  }
  if (changes.networkLogs) {
    const next = Array.isArray(changes.networkLogs.newValue) ? changes.networkLogs.newValue : [];
    renderNetLogs(next);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "PLAYBACK_PROGRESS") {
    // 进度信息不强制显示，避免刷屏；用户可在列表看到步骤量
    return;
  }
  if (msg.type === "STEPS_UPDATED") {
    // storage listener 会负责刷新
    return;
  }
});

(async () => {
  const steps = await getSteps();
  renderSteps(steps);
  const logs = await getNetworkLogs();
  renderNetLogs(logs);
  await refreshStatusUI();
  await refreshNetStatusUI();
})();

