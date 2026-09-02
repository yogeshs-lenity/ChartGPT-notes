// ChartGPT Notes — background service worker

const GITHUB_DISPATCH_URL =
  "https://api.github.com/repos/yogeshs-lenity/ChartGPT-notes/dispatches";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "SAVE_NOTE") return;
  saveNote(msg.payload);
  sendResponse({ ok: true });
});

async function saveNote(payload) {
  const { github_pat } = await chrome.storage.local.get("github_pat");
  if (!github_pat) {
    notify("ChartGPT Notes — not configured", "Open the extension popup and enter your GitHub PAT.");
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
        client_payload: payload,
      }),
    });

    if (resp.status === 204) {
      notify(
        `✓ Saved — ${payload.workflow_type}`,
        `${payload.patient_initials}  ·  ${payload.date_of_service}`
      );
    } else {
      const body = await resp.text();
      notify("ChartGPT Notes — save failed", `HTTP ${resp.status}: ${body.slice(0, 100)}`);
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
