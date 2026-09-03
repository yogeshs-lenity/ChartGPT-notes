// ChartGPT Notes — content script
// Based on OpenChatPDF (MIT) DOM capture approach

const RETRY_INTERVAL_MS = 1200;
const MAX_INIT_ATTEMPTS  = 25;

const MSG_SELECTORS = [
  'div[data-message-author-role]',
  'article[data-testid^="conversation-turn-"]',
];

let lastSavedKey     = null;
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

// ── MutationObserver ──────────────────────────────────────────────────────────
function attachObserver() {
  if (observerAttached) return;
  observerAttached = true;

  const observer = new MutationObserver(debounce(checkForCompletedNote, 800));
  observer.observe(document.body, { childList: true, subtree: true });

  // Reset dedup key on SPA navigation
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
        const clone = el.cloneNode(true);
        clone.querySelectorAll('button, svg, [aria-hidden="true"], .sr-only').forEach(n => n.remove());
        return { role, text: clone.innerText.trim() };
      }).filter(m => m.text);
    }
  }
  return [];
}

// ── Comprehensive completion detection ────────────────────────────────────────
// Covers every ChartGPT V10 workflow that produces a saveable final output.
function isCompletedNote(text) {
  // ECW Clinic — always ends with FINAL-OK TO PRINT
  if (text.includes('FINAL-OK TO PRINT')) return true;

  // Any Cerner output — ends with SLIM Billing Block
  // (Rounds, Consult, Procedure, Cardiac Cath, Tilt Table, Critical Care, Pre-procedure H&P)
  if (text.includes('SLIM Billing Block') &&
      text.includes('Date of Service:') &&
      text.includes('CPT:')) return true;

  // EPIC — ends after Patient Instructions (Spanish), no SLIM
  // Title always contains "New Consultation" or "Established Follow-Up"
  if (/^#\s+[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+(New Consultation|Established Follow-Up)/m.test(text) &&
      text.includes('## Patient Instructions (Spanish)')) return true;

  // Wellness Visit — contains Annual Wellness Statement + Spanish instructions
  if (text.includes('Annual Wellness Statement') &&
      text.includes('## Patient Instructions (Spanish)')) return true;

  // CCM Telephone Call — ends with Total CCM minutes
  if (text.includes('CCM Telephone Call') &&
      text.includes('Total CCM minutes:')) return true;

  // New Patient Intake — ends with Spanish instructions
  if (text.includes('NEW PATIENT INTAKE') &&
      text.includes('## Patient Instructions (Spanish)')) return true;

  // ECW Rhythm Monitoring — folder batch (# 1854-93224 - Rhythm Monitoring - MM/DD/YYYY)
  if (/^#\s+\d+-\d+\s+-\s+Rhythm Monitoring\s+-\s+\d{2}\/\d{2}\/\d{4}/m.test(text)) return true;

  // ECW Rhythm Monitoring — single patient 3-bullet format (no title)
  // First bullet: - INI TIA - Full Name: INI TIA rhythm monitoring reviewed.
  if (/^-\s+[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+.+:\s+[A-Z]{2,3}\s[A-Z]{2,3}\s+rhythm monitoring reviewed\./m.test(text)) return true;

  return false;
}

function checkForCompletedNote() {
  const messages = getMessages();
  if (!messages.length) return;

  const assistantMsgs = messages.filter(m => m.role === 'assistant');
  if (!assistantMsgs.length) return;

  const last = assistantMsgs[assistantMsgs.length - 1];
  const text = last.text;

  if (!isCompletedNote(text)) return;

  const key = text.slice(-80);
  if (key === lastSavedKey) return;
  lastSavedKey = key;

  const payload = buildPayload(messages, text);
  chrome.runtime.sendMessage({ type: 'QUEUE_NOTE', payload });
}

// ── Extract workflow metadata from completed note text ────────────────────────
function extractNoteMeta(noteText) {
  const today    = fmt(new Date());
  const slimDos  = (noteText.match(/Date of Service:\s*(\d{2}\/\d{2}\/\d{4})/) || [])[1] || today;

  // ECW Clinic
  let m = noteText.match(/^#\s+([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+ECW Clinic/m);
  if (m) return { initials: m[1], workflow: 'ECW Clinic', dos: today };

  // EPIC
  m = noteText.match(/^#\s+([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+(New Consultation|Established Follow-Up)/m);
  if (m) return { initials: m[1], workflow: 'EPIC', dos: today };

  // Wellness Visit
  m = noteText.match(/^#\s+([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+Wellness Visit/m);
  if (m) return { initials: m[1], workflow: 'Wellness Visit', dos: slimDos };

  // CCM Telephone Call
  m = noteText.match(/^#\s+([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+CCM Telephone Call\s+-\s+(\d{2}\/\d{2}\/\d{4})/m);
  if (m) return { initials: m[1], workflow: 'CCM Telephone Call', dos: m[2] };

  // New Patient Intake (different heading format — no # prefix on first line)
  m = noteText.match(/^([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+NEW PATIENT INTAKE\s+-\s+(\d{2}\/\d{2}\/\d{4})/m);
  if (m) return { initials: m[1], workflow: 'New Patient Intake', dos: m[2] };

  // ECW Rhythm Monitoring — folder batch
  m = noteText.match(/^#\s+(\d+-\d+)\s+-\s+Rhythm Monitoring\s+-\s+(\d{2}\/\d{2}\/\d{4})/m);
  if (m) return { initials: m[1], workflow: 'ECW Rhythm Monitoring', dos: m[2] };

  // ECW Rhythm Monitoring — single patient 3-bullet
  m = noteText.match(/^-\s+([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+/m);
  if (m && /rhythm monitoring reviewed/i.test(noteText)) {
    return { initials: m[1], workflow: 'ECW Rhythm Monitoring', dos: today };
  }

  // Cerner variants — extract initials and DOS from SLIM block
  const slimInitials = extractInitialsFromSlim(noteText);

  // Cardiac Cath uses plain-text heading (not markdown #)
  if (/^Cardiac Catheterization\s+-\s+\d{2}\/\d{2}\/\d{4}/m.test(noteText)) {
    return { initials: slimInitials, workflow: 'Cardiac Cath', dos: slimDos };
  }

  m = noteText.match(/^#\s+[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+Tilt Table/m);
  if (m) return { initials: slimInitials, workflow: 'Tilt Table Test', dos: slimDos };

  m = noteText.match(/^#\s+[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+Inpatient Cardiology Consult/m);
  if (m) return { initials: slimInitials, workflow: 'Cerner Consult', dos: slimDos };

  m = noteText.match(/^#\s+[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+Inpatient Cardiology Progress/m);
  if (m) return { initials: slimInitials, workflow: 'Cerner Rounds', dos: slimDos };

  m = noteText.match(/^#\s+[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+Pre-Procedure/m);
  if (m) return { initials: slimInitials, workflow: 'Cerner Procedure', dos: slimDos };

  // Generic Cerner fallback (any note with a SLIM block not matched above)
  if (noteText.includes('SLIM Billing Block')) {
    return { initials: slimInitials, workflow: 'Cerner Note', dos: slimDos };
  }

  return { initials: 'UNKNOWN', workflow: 'Clinical Note', dos: today };
}

// ── Build the payload to send to GitHub dispatch ──────────────────────────────
function buildPayload(messages, noteText) {
  const today = fmt(new Date());
  const { initials, workflow, dos } = extractNoteMeta(noteText);

  // Dictation = only user messages between previous and current assistant response.
  // Handles multi-patient sessions correctly despite ChatGPT's lazy DOM loading.
  const assistantIdxs = messages
    .map((m, i) => m.role === 'assistant' ? i : -1)
    .filter(i => i >= 0);
  const currentIdx = assistantIdxs[assistantIdxs.length - 1] ?? messages.length;
  const prevIdx    = assistantIdxs[assistantIdxs.length - 2] ?? -1;

  const dictation = messages
    .slice(prevIdx + 1, currentIdx)
    .filter(m => m.role === 'user')
    .map(m => m.text)
    .join('\n---\n');

  return {
    workflow_type:    workflow,
    patient_initials: initials,
    date_of_service:  dos,
    dictation,
    note_content:     noteText,
    session_date:     today,
  };
}

function extractInitialsFromSlim(text) {
  const m = text.match(/Patient Initials:\s*([A-Z]{2,3}\s[A-Z]{2,3})/);
  return m ? m[1] : 'UNKNOWN';
}

function fmt(d) {
  return `${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}/${d.getFullYear()}`;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

waitForUI();
