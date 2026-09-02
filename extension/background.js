// ChartGPT Notes — background service worker

const GITHUB_DISPATCH_URL =
  "https://api.github.com/repos/yogeshs-lenity/ChartGPT-notes/dispatches";

const SAVE_HOUR = 18; // 6 PM local time

// ── Schedule the daily 6 PM alarm ────────────────────────────────────────────
function scheduleDailyAlarm() {
  chrome.alarms.get("daily-save", (existing) => {
    if (existing) return; // already scheduled

    const now  = new Date();
    const fire = new Date();
    fire.setHours(SAVE_HOUR, 0, 0, 0);
    if (fire <= now) fire.setDate(fire.getDate() + 1); // already past 6 PM today

    chrome.alarms.create("daily-save", {
      when:           fire.getTime(),
      periodInMinutes: 24 * 60,
    });
  });
}

chrome.runtime.onInstalled.addListener(scheduleDailyAlarm);
chrome.runtime.onStartup.addListener(scheduleDailyAlarm);

// ── On alarm: flush the queue ─────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "daily-save") flushQueue();
});

// ── Queue a note from content.js ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "QUEUE_NOTE") {
    queueNote(msg.payload);
    sendResponse({ ok: true });
  }
  if (msg.type === "FLUSH_NOW") {
    flushQueue();
    sendResponse({ ok: true });
  }
  if (msg.type === "GET_QUEUE_COUNT") {
    chrome.storage.local.get("note_queue", ({ note_queue }) => {
      sendResponse({ count: (note_queue || []).length });
    });
    return true; // keep channel open for async sendResponse
  }
});

async function queueNote(payload) {
  const { note_queue = [] } = await chrome.storage.local.get("note_queue");

  // Deduplicate by note tail
  const key = payload.note_content.slice(-80);
  if (note_queue.some(n => n.note_content.slice(-80) === key)) return;

  note_queue.push(payload);
  await chrome.storage.local.set({ note_queue });

  notify(
    `Queued — ${payload.workflow_type}`,
    `${payload.patient_initials} · ${payload.date_of_service}  (${note_queue.length} note${note_queue.length > 1 ? "s" : ""} queued)`
  );
}

async function flushQueue() {
  const { note_queue = [], github_pat } = await chrome.storage.local.get(["note_queue", "github_pat"]);

  if (!note_queue.length) return;

  if (!github_pat) {
    notify("ChartGPT Notes — not configured", "Open the extension and enter your GitHub PAT.");
    return;
  }

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
        client_payload: { notes: note_queue },
      }),
    });

    if (resp.status === 204) {
      const count = note_queue.length;
      await chrome.storage.local.set({ note_queue: [] }); // clear queue
      notify(
        `✓ Saved ${count} note${count > 1 ? "s" : ""} to OneDrive`,
        note_queue.map(n => `${n.patient_initials} · ${n.date_of_service}`).join("\n")
      );
    } else {
      const body = await resp.text();
      notify("ChartGPT Notes — save failed", `HTTP ${resp.status}: ${body.slice(0, 120)}`);
    }
  } catch (err) {
    notify("ChartGPT Notes — network error", err.message);
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
