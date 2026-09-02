// ChartGPT Notes — content script
// Runs on chatgpt.com, watches for FINAL-OK TO PRINT and SLIM Billing Blocks

const FINAL_MARKERS = ["FINAL-OK TO PRINT"];
const SLIM_MARKER   = "SLIM Billing Block";

// Workflows that end with SLIM (Cerner) vs FINAL-OK TO PRINT (ECW/others)
const CERNER_WORKFLOWS = [
  "Cerner Rounds", "Cerner Consult", "Cerner Procedure",
  "Cardiac Cath", "Tilt Table", "CCM", "Wellness"
];

let lastSavedMessageId = null;

// ── Extract all conversation messages from the DOM ──────────────────────────
function getMessages() {
  const msgs = [];
  const elements = document.querySelectorAll('[data-message-author-role]');
  elements.forEach((el, idx) => {
    const role = el.getAttribute('data-message-author-role');
    const text = el.innerText.trim();
    if (text) msgs.push({ role, text, idx });
  });
  return msgs;
}

// ── Detect if an assistant message is a completed note ───────────────────────
function isCompletedNote(text) {
  return (
    FINAL_MARKERS.some(m => text.includes(m)) ||
    (text.includes(SLIM_MARKER) && text.includes("CPT:") && text.includes("Date of Service:"))
  );
}

// ── Parse workflow type from note title line ──────────────────────────────────
function parseWorkflow(text) {
  // Look for "# INITIALS - Workflow Name" pattern
  const titleMatch = text.match(/^#\s+([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+(.+?)(?:\s*Output)?$/m);
  if (titleMatch) return { initials: titleMatch[1], workflow: titleMatch[2].trim() };

  // Cerner: "# INITIALS - Inpatient Cardiology Progress Note"
  const cernerMatch = text.match(/^#\s+([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+(Inpatient|Cardiac|Tilt|Pre-Procedure|CCM|Wellness).+$/m);
  if (cernerMatch) return { initials: cernerMatch[1], workflow: cernerMatch[2].trim() };

  // Fallback: look for SLIM Patient Initials
  const slimMatch = text.match(/Patient Initials:\s*([A-Z]{2,3}\s[A-Z]{2,3})/);
  if (slimMatch) return { initials: slimMatch[1], workflow: "Clinical Note" };

  return { initials: "UNKNOWN", workflow: "Clinical Note" };
}

// ── Parse date of service ─────────────────────────────────────────────────────
function parseDate(text) {
  // SLIM Date of Service
  const slimDate = text.match(/Date of Service:\s*(\d{2}\/\d{2}\/\d{4})/);
  if (slimDate) return slimDate[1];

  // ECW session header date
  const headerDate = text.match(/(?:ECW clinic|CERNHOSP|Cerner|EPIC)\s*-\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (headerDate) return headerDate[1];

  // Today's date as fallback
  const today = new Date();
  return `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;
}

// ── Collect dictation messages before the completed note ─────────────────────
function getDictation(messages, noteIdx) {
  const userMsgs = messages
    .slice(0, noteIdx)
    .filter(m => m.role === 'user')
    .map(m => m.text);

  // Only keep messages from current session (after last session header)
  let sessionStart = 0;
  userMsgs.forEach((txt, i) => {
    if (/^(ECW clinic|CERNHOSP|EPIC dictation|Rhythm monitoring|Dr H|CCM Call|Wellness Visit)\s*-/i.test(txt)) {
      sessionStart = i;
    }
  });

  return userMsgs.slice(sessionStart).join('\n---\n');
}

// ── Main observer ─────────────────────────────────────────────────────────────
const observer = new MutationObserver(() => {
  const messages = getMessages();
  if (!messages.length) return;

  // Check the last few assistant messages for a completed note
  const assistantMsgs = messages.filter(m => m.role === 'assistant');
  if (!assistantMsgs.length) return;

  const last = assistantMsgs[assistantMsgs.length - 1];

  // Avoid re-saving the same message
  const msgId = last.idx + '_' + last.text.slice(-30);
  if (msgId === lastSavedMessageId) return;
  if (!isCompletedNote(last.text)) return;

  lastSavedMessageId = msgId;

  const { initials, workflow } = parseWorkflow(last.text);
  const dos       = parseDate(last.text);
  const today     = new Date();
  const sessionDate = `${String(today.getMonth()+1).padStart(2,'0')}/${String(today.getDate()).padStart(2,'0')}/${today.getFullYear()}`;
  const dictation = getDictation(messages, last.idx);

  const payload = {
    workflow_type:    workflow,
    patient_initials: initials,
    date_of_service:  dos,
    dictation:        dictation,
    note_content:     last.text,
    session_date:     sessionDate,
  };

  chrome.runtime.sendMessage({ type: "SAVE_NOTE", payload });
});

observer.observe(document.body, { childList: true, subtree: true });
