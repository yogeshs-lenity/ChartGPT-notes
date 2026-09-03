// ChartGPT Notes — background service worker

const GITHUB_DISPATCH_URL =
  "https://api.github.com/repos/yogeshs-lenity/ChartGPT-notes/dispatches";

const SAVE_HOUR = 18; // 6 PM local time

// ── Schedule daily 6 PM alarm ─────────────────────────────────────────────────
function scheduleDailyAlarm() {
  chrome.alarms.get("daily-save", (existing) => {
    if (existing) return;
    const now  = new Date();
    const fire = new Date();
    fire.setHours(SAVE_HOUR, 0, 0, 0);
    if (fire <= now) fire.setDate(fire.getDate() + 1);
    chrome.alarms.create("daily-save", { when: fire.getTime(), periodInMinutes: 24 * 60 });
  });
}

chrome.runtime.onInstalled.addListener(scheduleDailyAlarm);
chrome.runtime.onStartup.addListener(scheduleDailyAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "daily-save") flushQueue();
});

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
    const resp = await fetch(GITHUB_DISPATCH_URL, {
      method: "POST",
      headers: {
        "Accept":        "application/vnd.github+json",
        "Authorization": `Bearer ${github_pat}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        event_type:     "save_chartgpt_note",
        client_payload: { notes },
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
      // Queue is NOT cleared — notes remain available for retry
      await chrome.storage.local.set({
        last_sent_batch: { ...batch, status: "error", error: `HTTP ${resp.status}` },
      });
      notify(
        "ChartGPT Notes — dispatch failed",
        `HTTP ${resp.status} — notes preserved. Open popup to retry.`
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
