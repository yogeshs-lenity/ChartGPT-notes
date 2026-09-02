// ChartGPT Notes — content script
// Based on OpenChatPDF (MIT) DOM capture approach
// Auto-detects FINAL-OK TO PRINT and SLIM Billing Blocks, saves silently

const RETRY_INTERVAL_MS = 1200;
const MAX_INIT_ATTEMPTS  = 25;

// Stable selectors (same as OpenChatPDF — tested across ChatGPT UI versions)
const MSG_SELECTORS = [
  'div[data-message-author-role]',
  'article[data-testid^="conversation-turn-"]',
];

let lastSavedKey  = null;
let observerAttached = false;

// ── Wait for ChatGPT UI to load ───────────────────────────────────────────────
function waitForUI(attempt = 0) {
  if (attempt >= MAX_INIT_ATTEMPTS) return;

  const found = MSG_SELECTORS.some(sel => document.querySelector(sel));
  if (found) {
    attachObserver();
  } else {
    setTimeout(() => waitForUI(attempt + 1), RETRY_INTERVAL_MS);
  }
}

// ── MutationObserver: watch for new assistant messages ────────────────────────
function attachObserver() {
  if (observerAttached) return;
  observerAttached = true;

  const observer = new MutationObserver(debounce(checkForCompletedNote, 800));
  observer.observe(document.body, { childList: true, subtree: true });

  // Re-init on SPA navigation (ChatGPT navigates without full page reload)
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      lastSavedKey = null;
    }
  }, 1000);
}

// ── Get all messages using OpenChatPDF selectors ──────────────────────────────
function getMessages() {
  for (const sel of MSG_SELECTORS) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) {
      return Array.from(els).map(el => {
        const explicit = el.getAttribute('data-message-author-role');
        const role = explicit || ((el.getAttribute('data-testid') || '').includes('user') ? 'user' : 'assistant');
        // Clone and clean — remove buttons, SVGs, hidden controls (OpenChatPDF approach)
        const clone = el.cloneNode(true);
        clone.querySelectorAll('button, svg, [aria-hidden="true"], .sr-only').forEach(n => n.remove());
        return { role, text: clone.innerText.trim() };
      }).filter(m => m.text);
    }
  }
  return [];
}

// ── Check if the latest assistant message is a completed note ─────────────────
function checkForCompletedNote() {
  const messages = getMessages();
  if (!messages.length) return;

  const assistantMsgs = messages.filter(m => m.role === 'assistant');
  if (!assistantMsgs.length) return;

  const last = assistantMsgs[assistantMsgs.length - 1];
  const text = last.text;

  const isCompleted = text.includes('FINAL-OK TO PRINT') ||
    (text.includes('SLIM Billing Block') &&
     text.includes('CPT:') &&
     text.includes('Date of Service:'));

  if (!isCompleted) return;

  // Deduplicate — don't save the same note twice
  const key = text.slice(-80);
  if (key === lastSavedKey) return;
  lastSavedKey = key;

  const payload = buildPayload(messages, text);
  chrome.runtime.sendMessage({ type: 'QUEUE_NOTE', payload });
}

// ── Build the payload to send to GitHub dispatch ──────────────────────────────
function buildPayload(messages, noteText) {
  const today = new Date();
  const sessionDate = fmt(today);

  // Parse workflow + initials from note title: "# KAR SIN - ECW Clinic Output"
  const titleMatch = noteText.match(/^#\s+([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+(.+?)(?:\s*Output)?\s*$/m);
  const initials   = titleMatch ? titleMatch[1] : extractInitialsFromSlim(noteText);
  const workflow   = titleMatch ? titleMatch[2].trim() : guessWorkflow(noteText);

  // Date of service from SLIM or session header
  const dosMatch = noteText.match(/Date of Service:\s*(\d{2}\/\d{2}\/\d{4})/);
  const dos       = dosMatch ? dosMatch[1] : sessionDate;

  // Dictation = all user messages from this session
  const userMsgs = messages.filter(m => m.role === 'user');
  let sessionStart = 0;
  userMsgs.forEach((m, i) => {
    if (/^(ECW clinic|CERNHOSP|EPIC dictation|Rhythm monitoring|Dr H|CCM Call|Wellness Visit)\s*-/i.test(m.text)) {
      sessionStart = i;
    }
  });
  const dictation = userMsgs.slice(sessionStart).map(m => m.text).join('\n---\n');

  return {
    workflow_type:    workflow,
    patient_initials: initials,
    date_of_service:  dos,
    dictation,
    note_content:     noteText,
    session_date:     sessionDate,
  };
}

function extractInitialsFromSlim(text) {
  const m = text.match(/Patient Initials:\s*([A-Z]{2,3}\s[A-Z]{2,3})/);
  return m ? m[1] : 'UNKNOWN';
}

function guessWorkflow(text) {
  if (text.includes('FINAL-OK TO PRINT'))       return 'ECW Clinic';
  if (text.includes('Cardiac Catheterization'))  return 'Cardiac Cath 93458';
  if (text.includes('Tilt Table'))               return 'Tilt Table Test';
  if (text.includes('Inpatient Cardiology'))     return 'Cerner Rounds';
  if (text.includes('Consult Note'))             return 'Cerner Consult';
  if (text.includes('CCM Telephone'))            return 'CCM Telephone Call';
  if (text.includes('Wellness Visit'))           return 'Wellness Visit';
  return 'Clinical Note';
}

function fmt(d) {
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── Start ─────────────────────────────────────────────────────────────────────
waitForUI();
