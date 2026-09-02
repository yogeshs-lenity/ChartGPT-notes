const patInput  = document.getElementById("patInput");
const saveBtn   = document.getElementById("saveBtn");
const flushBtn  = document.getElementById("flushBtn");
const statusMsg = document.getElementById("statusMsg");
const statusDot = document.getElementById("statusDot");
const queueCount = document.getElementById("queueCount");

// Load saved PAT + queue count on open
chrome.storage.local.get(["github_pat", "note_queue"], ({ github_pat, note_queue }) => {
  if (github_pat) {
    patInput.value = github_pat;
    statusDot.style.background = "#22c55e";
  } else {
    statusDot.style.background = "#ef4444";
  }

  const count = (note_queue || []).length;
  queueCount.textContent = count;
  flushBtn.disabled = count === 0;
});

saveBtn.addEventListener("click", () => {
  const pat = patInput.value.trim();
  if (!pat) { showStatus("Enter a PAT first.", "error"); return; }
  chrome.storage.local.set({ github_pat: pat }, () => {
    statusDot.style.background = "#22c55e";
    showStatus("Saved ✓", "ok");
  });
});

flushBtn.addEventListener("click", () => {
  flushBtn.disabled = true;
  flushBtn.textContent = "Sending…";
  chrome.runtime.sendMessage({ type: "FLUSH_NOW" }, () => {
    showStatus("Sent to OneDrive ✓", "ok");
    queueCount.textContent = "0";
  });
});

function showStatus(msg, type) {
  statusMsg.textContent = msg;
  statusMsg.style.color = type === "ok" ? "#22c55e" : "#ef4444";
  setTimeout(() => { statusMsg.textContent = ""; }, 3000);
}
