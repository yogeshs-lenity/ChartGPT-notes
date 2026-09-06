// ChartGPT Notes — background service worker

const GITHUB_REPO         = "yogeshs-lenity/ChartGPT-notes";
const GITHUB_DISPATCH_URL = `https://api.github.com/repos/${GITHUB_REPO}/dispatches`;
const GITHUB_CONTENTS_URL = `https://api.github.com/repos/${GITHUB_REPO}/contents`;

const SAVE_HOUR   = 6;  // 6:30 AM IST = 6 PM PDT
const SAVE_MINUTE = 30;

// ── Schedule daily 6:30 AM alarm ──────────────────────────────────────────────
function scheduleDailyAlarm() {
  chrome.alarms.get("daily-save", (existing) => {
    if (existing) return;
    const now  = new Date();
    const fire = new Date();
    fire.setHours(SAVE_HOUR, SAVE_MINUTE, 0, 0);
    if (fire <= now) fire.setDate(fire.getDate() + 1);
    chrome.alarms.create("daily-save", { when: fire.getTime(), periodInMinutes: 24 * 60 });
  });
}

chrome.runtime.onInstalled.addListener(scheduleDailyAlarm);
chrome.runtime.onStartup.addListener(scheduleDailyAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "daily-save") dailySave();
});

// Per-tab raw conversation JSON (cleared when tab closes)
const tabConversations = new Map();
chrome.tabs.onRemoved.addListener(id => tabConversations.delete(id));

// ── Daily 6:30 AM save ────────────────────────────────────────────────────────
// Dispatches every conversation captured since the last save, then flushes
// any individually queued notes. Conversations are stored in daily_conv_cache
// as they arrive so they survive tab closure before the alarm fires.
async function dailySave() {
  const { github_pat, daily_conv_cache = {} } =
    await chrome.storage.local.get(["github_pat", "daily_conv_cache"]);

  // Merge still-open tabs in case their SCAN_DONE fires late
  for (const [tabId, convData] of tabConversations) {
    const id = convData?.conversation_id || String(tabId);
    daily_conv_cache[id] = convData;
  }

  // Skip the _date sentinel key when counting/iterating conversations
  const convIds = Object.keys(daily_conv_cache).filter(k => k !== "_date");
  if (convIds.length) {
    notify("ChartGPT Notes — daily save", `Processing ${convIds.length} conversation(s)…`);
    for (const id of convIds) {
      try {
        await dispatchConversation(daily_conv_cache[id], github_pat);
      } catch (e) {
        notify("ChartGPT Notes — dispatch error", e.message);
      }
    }
    // Reset cache but keep today's date stamp so stale entries don't re-accumulate
    await chrome.storage.local.set({ daily_conv_cache: { _date: new Date().toDateString() } });
  }

  // Flush any individually queued notes (legacy / manual path)
  await flushQueue();
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "RAW_CONV") {
    // Store in memory keyed by tab — used by importConversation()
    if (sender.tab?.id) tabConversations.set(sender.tab.id, msg.data);
    // Persist to daily cache so it survives if the tab closes before 6:30 AM.
    // Reset the cache when the date changes so old conversations don't bleed into
    // the next day's dispatch.
    const convId  = msg.data?.conversation_id || String(sender.tab?.id || Date.now());
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
    flushQueue();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "REMOVE_NOTE") {
    removeNote(msg.key).then(() => sendResponse({ ok: true }));
    return true; // async
  }
  if (msg.type === "RESEND_LAST") {
    resendLast().then(() => sendResponse({ ok: true }));
    return true; // async
  }
  if (msg.type === "IMPORT_URL") {
    importConversation(msg.url).then(() => sendResponse({ ok: true }));
    return true; // async
  }
  if (msg.type === "GET_STATE") {
    chrome.storage.local.get(
      ["note_queue", "github_pat", "last_sent_batch"],
      ({ note_queue, github_pat, last_sent_batch }) => {
        sendResponse({
          queue:     note_queue     || [],
          hasPat:    !!github_pat,
          lastBatch: last_sent_batch || null,
        });
      }
    );
    return true; // async
  }
});

// ── Import a conversation by URL ──────────────────────────────────────────────
// Opens the URL in a visible tab. The content script's initial scan fires
// automatically, queuing all detected completed notes. The tab is closed after
// SCAN_DONE is received from the content script (or after a 15-second timeout).
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

      // Prefer raw conversation JSON → chartgpt_notes.py does all detection
      const rawConv = tabConversations.get(tab.id);
      if (rawConv) {
        const { github_pat } = await chrome.storage.local.get("github_pat");
        await dispatchConversation(rawConv, github_pat);
        finish();
        return;
      }

      // Fallback: flush whatever individual notes the content script queued
      await flushQueue();
      finish();
    };
    chrome.runtime.onMessage.addListener(scanListener);
  });
}

// ── Queue a note (with deduplication) ────────────────────────────────────────
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

// ── Remove a single note from the queue by its dedup key ─────────────────────
async function removeNote(key) {
  const { note_queue = [] } = await chrome.storage.local.get("note_queue");
  const filtered = note_queue.filter(n => n.note_content.slice(-80) !== key);
  await chrome.storage.local.set({ note_queue: filtered });
}

// ── Flush current queue to GitHub Actions ─────────────────────────────────────
async function flushQueue() {
  const { note_queue = [], github_pat } = await chrome.storage.local.get(["note_queue", "github_pat"]);
  if (!note_queue.length) return;
  await dispatch(note_queue, github_pat, /* clearQueueOnSuccess */ true);
}

// ── Resend the notes from the last batch ─────────────────────────────────────
// Useful when GitHub dispatch succeeded (HTTP 204) but the Actions job itself
// failed — queue was already cleared, but batch is preserved here.
async function resendLast() {
  const { last_sent_batch, github_pat } = await chrome.storage.local.get(["last_sent_batch", "github_pat"]);
  if (!last_sent_batch?.notes?.length) return;
  await dispatch(last_sent_batch.notes, github_pat, /* clearQueueOnSuccess */ false);
}

// ── Upload payload to repo inbox (bypasses GitHub's 25KB dispatch limit) ─────
// Writes JSON to inbox/notes_<ts>.json via Contents API, returns the path.
// The workflow reads and deletes the file. PAT needs repo (classic) or
// Contents:write (fine-grained) scope.
async function uploadToInbox(payload, pat) {
  const path = `inbox/notes_${Date.now()}.json`;
  const json = JSON.stringify(payload);
  // btoa requires latin1; encode UTF-8 bytes correctly
  const bytes = new TextEncoder().encode(json);
  const binStr = Array.from(bytes, b => String.fromCharCode(b)).join('');
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
    let msg = '';
    try { msg = JSON.parse(body)?.message; } catch {}
    throw new Error(`Inbox upload HTTP ${resp.status}: ${msg || body.slice(0, 120)}`);
  }
  return path;
}

// ── Dispatch raw conversation JSON (new path — chartgpt_notes.py detects) ────
async function dispatchConversation(convData, github_pat) {
  if (!github_pat) {
    notify("ChartGPT Notes", "Open the extension and enter your GitHub PAT.");
    return;
  }
  const batch = {
    notes:     [],
    count:     0,
    sent_at:   new Date().toISOString(),
    status:    "sending",
    summaries: ["Full conversation — chartgpt_notes.py will detect notes"],
  };
  await chrome.storage.local.set({ last_sent_batch: batch });
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
      await chrome.storage.local.set({ last_sent_batch: { ...batch, status: "sent", count: 1 } });
      notify("✓ Conversation dispatched — PDF generating", "chartgpt_notes.py will extract all notes");
    } else {
      const body2 = await resp.text();
      let detail2 = '';
      try { detail2 = JSON.parse(body2)?.message || body2.slice(0, 120); } catch { detail2 = body2.slice(0, 120); }
      await chrome.storage.local.set({ last_sent_batch: { ...batch, status: "error", error: `HTTP ${resp.status}: ${detail2}` } });
      notify(`ChartGPT Notes — HTTP ${resp.status}`, detail2 || "Open popup to retry.");
    }
  } catch (err) {
    await chrome.storage.local.set({ last_sent_batch: { ...batch, status: "error", error: err.message } });
    notify("ChartGPT Notes — upload/dispatch error", err.message);
  }
}

// ── Core dispatch ─────────────────────────────────────────────────────────────
async function dispatch(notes, github_pat, clearQueueOnSuccess) {
  if (!github_pat) {
    notify("ChartGPT Notes", "Open the extension and enter your GitHub PAT.");
    return;
  }

  // Persist batch BEFORE network call so no data is lost if the call hangs or fails
  const batch = {
    notes,
    count:     notes.length,
    sent_at:   new Date().toISOString(),
    status:    "sending",
    summaries: notes.map(n => `${n.patient_initials} · ${n.date_of_service}`),
  };
  await chrome.storage.local.set({ last_sent_batch: batch });

  try {
    // Upload full notes array (with note_content) to repo inbox — GitHub's
    // 25KB client_payload limit would reject clinical note content directly.
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
      // GitHub received the dispatch. Clear queue only if this was the live queue
      // (not a resend of an old batch).
      if (clearQueueOnSuccess) {
        await chrome.storage.local.set({ note_queue: [] });
      }
      await chrome.storage.local.set({ last_sent_batch: { ...batch, status: "sent" } });
      notify(
        `✓ ${batch.count} note${batch.count > 1 ? "s" : ""} dispatched to OneDrive`,
        batch.summaries.join("\n")
      );
    } else {
      const body = await resp.text();
      let detail = '';
      try { detail = JSON.parse(body)?.message || body.slice(0, 120); } catch { detail = body.slice(0, 120); }
      await chrome.storage.local.set({
        last_sent_batch: { ...batch, status: "error", error: `HTTP ${resp.status}: ${detail}` },
      });
      notify(
        `ChartGPT Notes — HTTP ${resp.status}`,
        detail || "Open popup to retry."
      );
    }
  } catch (err) {
    // Network error — queue also NOT cleared
    await chrome.storage.local.set({
      last_sent_batch: { ...batch, status: "error", error: err.message },
    });
    notify(
      "ChartGPT Notes — network error",
      `${err.message} — notes preserved. Open popup to retry.`
    );
  }
}

function notify(title, message) {
  chrome.notifications.create({
    type:    "basic",
    iconUrl: "icon.png",
    title,
    message,
  });
}
