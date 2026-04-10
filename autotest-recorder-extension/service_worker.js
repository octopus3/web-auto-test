let attachedTabId = null;
let netEnabled = false;
const reqMap = new Map(); // requestId -> partial log

async function getNetworkLogs() {
  const { networkLogs = [] } = await chrome.storage.local.get({ networkLogs: [] });
  return Array.isArray(networkLogs) ? networkLogs : [];
}

async function pushNetworkLog(entry) {
  const logs = await getNetworkLogs();
  logs.push(entry);
  const limited = logs.slice(-200);
  await chrome.storage.local.set({ networkLogs: limited });
}

async function clearNetworkLogs() {
  await chrome.storage.local.set({ networkLogs: [] });
}

function dbgTarget(tabId) {
  return { tabId };
}

async function attachDebugger(tabId) {
  if (attachedTabId && attachedTabId !== tabId) {
    await detachDebugger(attachedTabId);
  }
  if (attachedTabId === tabId && netEnabled) return;

  await chrome.debugger.attach(dbgTarget(tabId), "1.3");
  attachedTabId = tabId;
  netEnabled = true;
  reqMap.clear();
  await chrome.debugger.sendCommand(dbgTarget(tabId), "Network.enable", {});
}

async function detachDebugger(tabId) {
  try {
    await chrome.debugger.detach(dbgTarget(tabId));
  } catch {
    // ignore
  } finally {
    if (attachedTabId === tabId) attachedTabId = null;
    netEnabled = false;
    reqMap.clear();
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source || source.tabId == null) return;
  if (!netEnabled || attachedTabId !== source.tabId) return;

  try {
    if (method === "Network.requestWillBeSent") {
      const { requestId, request, documentURL, wallTime, type } = params || {};
      if (!requestId || !request) return;
      reqMap.set(requestId, {
        ts: Date.now(),
        wallTime,
        type,
        documentURL,
        requestId,
        request: {
          url: request.url,
          method: request.method,
          headers: request.headers || {},
          postData: request.postData
        }
      });
      return;
    }

    if (method === "Network.responseReceived") {
      const { requestId, response } = params || {};
      if (!requestId || !response) return;
      const cur = reqMap.get(requestId) || { ts: Date.now(), requestId };
      cur.response = {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        mimeType: response.mimeType,
        headers: response.headers || {}
      };
      reqMap.set(requestId, cur);
      return;
    }

    if (method === "Network.loadingFinished") {
      const { requestId, encodedDataLength } = params || {};
      if (!requestId) return;
      (async () => {
        const cur = reqMap.get(requestId) || { ts: Date.now(), requestId };
        cur.encodedDataLength = encodedDataLength;
        try {
          const bodyRes = await chrome.debugger.sendCommand(dbgTarget(source.tabId), "Network.getResponseBody", {
            requestId
          });
          if (bodyRes) {
            cur.responseBody = {
              body: bodyRes.body,
              base64Encoded: Boolean(bodyRes.base64Encoded)
            };
          }
        } catch (e) {
          cur.responseBodyError = e?.message || String(e);
        }
        await pushNetworkLog(cur);
        reqMap.delete(requestId);
      })();
      return;
    }

    if (method === "Network.loadingFailed") {
      const { requestId, errorText } = params || {};
      if (!requestId) return;
      const cur = reqMap.get(requestId) || { ts: Date.now(), requestId };
      cur.loadingFailed = true;
      cur.errorText = errorText;
      reqMap.delete(requestId);
      pushNetworkLog(cur);
    }
  } catch {
    // swallow
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (attachedTabId === tabId) detachDebugger(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "PING") {
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "GET_ACTIVE_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      sendResponse({ ok: true, tabId: tab?.id ?? null, url: tab?.url ?? null });
    });
    return true;
  }

  if (msg.type === "NET_START") {
    (async () => {
      try {
        await attachDebugger(msg.tabId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "NET_STOP") {
    (async () => {
      try {
        if (attachedTabId) await detachDebugger(attachedTabId);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "NET_STATUS") {
    sendResponse({ ok: true, enabled: netEnabled, attachedTabId });
    return true;
  }

  if (msg.type === "NET_GET_LOGS") {
    (async () => {
      const logs = await getNetworkLogs();
      sendResponse({ ok: true, logs });
    })();
    return true;
  }

  if (msg.type === "NET_CLEAR_LOGS") {
    (async () => {
      await clearNetworkLogs();
      sendResponse({ ok: true });
    })();
    return true;
  }
});

