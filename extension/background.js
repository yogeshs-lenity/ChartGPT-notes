// ChartGPT Notes — background service worker

const GITHUB_REPO         = "yogeshs-lenity/ChartGPT-notes";
const GITHUB_DISPATCH_URL = `https://api.github.com/repos/${GITHUB_REPO}/dispatches`;
const GITHUB_CONTENTS_URL = `https://api.github.com/repos/${GITHUB_REPO}/contents`;

const SAVE_HOUR   = 18; // 6:00 PM local time (Oxnard = Pacific)
const SAVE_MINUTE = 0;

// ── Schedule daily alarm ───────────────────────────────────────────────────────
// Always clears and recreates so that changes to SAVE_HOUR/SAVE_MINUTE take
// effect immediately on the next extension load — no reinstall needed.
function scheduleDailyAlarm() {
  chrome.alarms.clear("daily-save", () => {
    const now  = new Date();
    const fire = new Date();
    fire.setHours(SAVE_HOUR, SAVE_MINUTE, 0, 0);
    if (fire <= now) fire.setDate(fire.getDate() + 1);
    chrome.alarms.create("daily-save", { when: fire.getTime(), periodInMinutes: 24 * 60 });
  });
}

chrome.runtime.onInstalled.addListener(scheduleDailyAlarm);

// On startup: reschedule AND catch up if Chrome was closed at save time.
chrome.runtime.onStartup.addListener(() => {
  scheduleDailyAlarm();
  catchUpIfMissed();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "daily-save") dailySave();
});

// ── Catch-up: run if Chrome was closed during the scheduled save window ───────
async function catchUpIfMissed() {
  const { last_save_date } = await chrome.storage.local.get("last_save_date");
  const today = new Date().toDateString();
  const now   = new Date();
  if (last_save_date !== today && now.getHours() >= SAVE_HOUR) {
    await dailySave();
  }
}

// Per-tab raw conversation JSON (cleared when tab closes)
const tabConversations = new Map();
chrome.tabs.onRemoved.addListener(id => tabConversations.delete(id));

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "RAW_CONV") {
    if (sender.tab?.id) tabConversations.set(sender.tab.id, msg.data);
    // Keep daily_conv_cache as a fallback (e.g. for resend)
    const convId   = msg.data?.conversation_id || String(sender.tab?.id || Date.now());
    const todayStr = new Date().toDateString();
    chrome.storage.local.get("daily_conv_cache", ({ daily_conv_cache = {} }) => {
      if (daily_conv_cache._date !== todayStr) daily_conv_cache = { _date: todayStr };
      daily_conv_cache[convId] = msg.data;
      chrome.storage.local.set({ daily_conv_cache });
    });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "QUEUE_NOTE") {
    queueNote(msg.payload);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "FLUSH_NOW") {
    dailySave().then(() => sendResponse({ ok: true }));
    return true; // async
  }
  if (msg.type === "REMOVE_NOTE") {
    removeNote(msg.key).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "RESEND_LAST") {
    resendLast().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "IMPORT_URL") {
    importConversation(msg.url).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "GET_STATE") {
    chrome.storage.local.get(
      ["note_queue", "github_pat", "last_sent_batch", "daily_conv_cache"],
      ({ note_queue, github_pat, last_sent_batch, daily_conv_cache = {} }) => {
        const convIds = Object.keys(daily_conv_cache).filter(k => k !== "_date");
        sendResponse({
          queue:      note_queue     || [],
          hasPat:     !!github_pat,
          lastBatch:  last_sent_batch || null,
          convCount:  convIds.length,
          convTitles: convIds.map(id => (daily_conv_cache[id]?.title || id).slice(0, 55)),
        });
      }
    );
    return true;
  }
});

// ── Daily save — re-fetches all conversations updated today ───────────────────
// Does a fresh API sweep so notes dictated after page load are included.
// Falls back to legacy queue if the sweep fails.
async function dailySave() {
  const { github_pat } = await chrome.storage.local.get("github_pat");
  if (!github_pat) {
    notify("ChartGPT Notes", "Open the extension and enter your GitHub PAT.");
    return;
  }

  notify("ChartGPT Notes — saving", "Collecting today's conversations…");

  let conversations = [];
  try {
    conversations = await sweepTodaysConversations();
  } catch (e) {
    notify("ChartGPT Notes — sweep error", e.message + " — falling back to queue");
    await flushQueue();
    return;
  }

  if (!conversations.length) {
    notify("ChartGPT Notes", "No conversations found for today.");
    await chrome.storage.local.set({ last_save_date: new Date().toDateString() });
    return;
  }

  try {
    const inboxPath = await uploadToInbox({ conversations }, github_pat);
    const resp = await fetch(GITHUB_DISPATCH_URL, {
      method:  "POST",
      headers: {
        "Accept":        "application/vnd.github+json",
        "Authorization": `Bearer ${github_pat}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        event_type:     "save_chartgpt_note",
        client_payload: { inbox_file: inboxPath },
      }),
    });
    if (resp.status === 204) {
      await chrome.storage.local.set({ last_save_date: new Date().toDateString() });
      notify(`✓ ${conversations.length} conversation(s) dispatched`, "PDF generating on GitHub Actions");
    } else {
      notify("ChartGPT Notes — dispatch error", `HTTP ${resp.status}`);
    }
  } catch (e) {
    notify("ChartGPT Notes — error", e.message);
  }
}

// ── Find or open a ChatGPT tab and ask content.js to fetch today's convs ──────
async function sweepTodaysConversations() {
  const tabs = await chrome.tabs.query({ url: "*://chatgpt.com/*" });
  let tabId;
  let opened = false;

  if (tabs.length > 0) {
    tabId = tabs[0].id;
  } else {
    const tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
    tabId = tab.id;
    opened = true;
    await tabFullyLoaded(tabId);
    await sleep(1500); // give content script time to initialise
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (opened) chrome.tabs.remove(tabId).catch(() => {});
      reject(new Error("Daily sweep timed out after 60s"));
    }, 60000);

    chrome.tabs.sendMessage(tabId, { type: "DAILY_SWEEP" }, (response) => {
      clearTimeout(timer);
      if (opened) chrome.tabs.remove(tabId).catch(() => {});
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.ok) resolve(response.conversations || []);
      else reject(new Error(response?.error || "Sweep returned no data"));
    });
  });
}

// ── Import a conversation by URL ──────────────────────────────────────────────
async function importConversation(url) {
  return new Promise(async (resolve) => {
    const tab = await chrome.tabs.create({ url, active: true });
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(scanListener);
      clearTimeout(timer);
      setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 1200);
      resolve();
    };

    const timer = setTimeout(finish, 45000);

    const scanListener = async (msg, sender) => {
      if (msg.type !== "SCAN_DONE" || sender.tab?.id !== tab.id) return;
      const rawConv = tabConversations.get(tab.id);
      if (rawConv) {
        const { github_pat } = await chrome.storage.local.get("github_pat");
        await dispatchConversation(rawConv, github_pat);
        finish();
        return;
      }
      await flushQueue();
      finish();
    };
    chrome.runtime.onMessage.addListener(scanListener);
  });
}

// ── Queue a note (legacy individual-note path) ────────────────────────────────
async function queueNote(payload) {
  const { note_queue = [] } = await chrome.storage.local.get("note_queue");
  const key = payload.note_content.slice(-80);
  if (note_queue.some(n => n.note_content.slice(-80) === key)) return;
  note_queue.push(payload);
  await chrome.storage.local.set({ note_queue });
  notify(
    `Queued — ${payload.workflow_type}`,
    `${payload.patient_initials} · ${payload.date_of_service}  (${note_queue.length} note${note_queue.length > 1 ? "s" : ""} queued)`
  );
}

async function removeNote(key) {
  const { note_queue = [] } = await chrome.storage.local.get("note_queue");
  await chrome.storage.local.set({ note_queue: note_queue.filter(n => n.note_content.slice(-80) !== key) });
}

async function flushQueue() {
  const { note_queue = [], github_pat } = await chrome.storage.local.get(["note_queue", "github_pat"]);
  if (!note_queue.length) return;
  await dispatch(note_queue, github_pat, true);
}

async function resendLast() {
  const { last_sent_batch, github_pat } = await chrome.storage.local.get(["last_sent_batch", "github_pat"]);
  if (!last_sent_batch?.notes?.length) return;
  await dispatch(last_sent_batch.notes, github_pat, false);
}

// ── Upload payload to repo inbox ──────────────────────────────────────────────
async function uploadToInbox(payload, pat) {
  const path  = `inbox/notes_${Date.now()}.json`;
  const json  = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  const binStr = Array.from(bytes, b => String.fromCharCode(b)).join("");
  const base64 = btoa(binStr);

  const resp = await fetch(`${GITHUB_CONTENTS_URL}/${path}`, {
    method:  "PUT",
    headers: {
      "Accept":        "application/vnd.github+json",
      "Authorization": `Bearer ${pat}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      message: `ChartGPT Notes inbox — ${new Date().toISOString()}`,
      content: base64,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    let msg = "";
    try { msg = JSON.parse(body)?.message; } catch {}
    throw new Error(`Inbox upload HTTP ${resp.status}: ${msg || body.slice(0, 120)}`);
  }
  return path;
}

// ── Dispatch a single raw conversation object (used by importConversation) ────
async function dispatchConversation(convData, github_pat) {
  if (!github_pat) {
    notify("ChartGPT Notes", "Open the extension and enter your GitHub PAT.");
    return;
  }
  try {
    const inboxPath = await uploadToInbox({ conversation: convData }, github_pat);
    const resp = await fetch(GITHUB_DISPATCH_URL, {
      method:  "POST",
      headers: {
        "Accept":        "application/vnd.github+json",
        "Authorization": `Bearer ${github_pat}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        event_type:     "save_chartgpt_note",
        client_payload: { inbox_file: inboxPath },
      }),
    });
    if (resp.status === 204) {
      notify("✓ Conversation dispatched — PDF generating", "chartgpt_notes.py will extract all notes");
    } else {
      notify(`ChartGPT Notes — HTTP ${resp.status}`, "Import dispatch failed");
    }
  } catch (err) {
    notify("ChartGPT Notes — error", err.message);
  }
}

// ── Core legacy dispatch (notes array) ───────────────────────────────────────
async function dispatch(notes, github_pat, clearQueueOnSuccess) {
  if (!github_pat) {
    notify("ChartGPT Notes", "Open the extension and enter your GitHub PAT.");
    return;
  }
  const batch = {
    notes,
    count:     notes.length,
    sent_at:   new Date().toISOString(),
    status:    "sending",
    summaries: notes.map(n => `${n.patient_initials} · ${n.date_of_service}`),
  };
  await chrome.storage.local.set({ last_sent_batch: batch });

  try {
    const inboxPath = await uploadToInbox({ notes }, github_pat);
    const resp = await fetch(GITHUB_DISPATCH_URL, {
      method: "POST",
      headers: {
        "Accept":        "application/vnd.github+json",
        "Authorization": `Bearer ${github_pat}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        event_type:     "save_chartgpt_note",
        client_payload: { inbox_file: inboxPath },
      }),
    });

    if (resp.status === 204) {
      if (clearQueueOnSuccess) await chrome.storage.local.set({ note_queue: [] });
      await chrome.storage.local.set({ last_sent_batch: { ...batch, status: "sent" } });
      notify(`✓ ${batch.count} note${batch.count > 1 ? "s" : ""} dispatched`, batch.summaries.join("\n"));
    } else {
      const body = await resp.text();
      let detail = "";
      try { detail = JSON.parse(body)?.message || body.slice(0, 120); } catch { detail = body.slice(0, 120); }
      await chrome.storage.local.set({ last_sent_batch: { ...batch, status: "error", error: `HTTP ${resp.status}: ${detail}` } });
      notify(`ChartGPT Notes — HTTP ${resp.status}`, detail || "Open popup to retry.");
    }
  } catch (err) {
    await chrome.storage.local.set({ last_sent_batch: { ...batch, status: "error", error: err.message } });
    notify("ChartGPT Notes — network error", `${err.message} — notes preserved.`);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function tabFullyLoaded(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(resolve, 10000); // fallback
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function notify(title, message) {
  chrome.notifications.create({
    type:    "basic",
    iconUrl: "icon.png",
    title,
    message,
  });
}
