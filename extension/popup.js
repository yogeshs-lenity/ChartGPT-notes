const patInput  = document.getElementById("patInput");
const saveBtn   = document.getElementById("saveBtn");
const statusMsg = document.getElementById("statusMsg");
const statusDot = document.getElementById("statusDot");

// Load saved PAT on open
chrome.storage.local.get("github_pat", ({ github_pat }) => {
  if (github_pat) {
    patInput.value = github_pat;
    setConfigured(true);
  } else {
    setConfigured(false);
  }
});

saveBtn.addEventListener("click", () => {
  const pat = patInput.value.trim();
  if (!pat) {
    showStatus("Enter a GitHub PAT first.", "error");
    return;
  }
  chrome.storage.local.set({ github_pat: pat }, () => {
    setConfigured(true);
    showStatus("Saved ✓", "ok");
  });
});

function setConfigured(ok) {
  statusDot.style.background = ok ? "#22c55e" : "#ef4444";
}

function showStatus(msg, type) {
  statusMsg.textContent = msg;
  statusMsg.style.color = type === "ok" ? "#22c55e" : "#ef4444";
  setTimeout(() => { statusMsg.textContent = ""; }, 3000);
}
