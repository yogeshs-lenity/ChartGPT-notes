// ChartGPT Notes — content script
// Based on OpenChatPDF (MIT) DOM capture approach

const RETRY_INTERVAL_MS = 1200;
const MAX_INIT_ATTEMPTS  = 25;

const MSG_SELECTORS = [
  'div[data-message-author-role]',
  'article[data-testid^="conversation-turn-"]',
];

// Set of queued note keys — prevents double-queuing within the same page load
const savedKeys = new Set();
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

  const observer = new MutationObserver(debounce(checkForCompletedNotes, 800));
  observer.observe(document.body, { childList: true, subtree: true });

  // Initial scan: detects notes already rendered in the DOM.
  // Covers navigating to an existing conversation with completed notes.
  checkForCompletedNotes();

  // After the page settles, re-scan and signal background that import is done.
  // The 3-second delay lets ChatGPT finish rendering any remaining messages.
  setTimeout(() => {
    checkForCompletedNotes();
    chrome.runtime.sendMessage({ type: 'SCAN_DONE', count: savedKeys.size }).catch(() => {});
  }, 3000);

  // Reset on SPA navigation (ChatGPT navigates without a full page reload)
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      savedKeys.clear();
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
function isCompletedNote(text) {
  // ECW Clinic
  if (text.includes('FINAL-OK TO PRINT')) return true;

  // Any Cerner/Lexiscan output — two SLIM formats across ChartGPT versions:
  // V10: "## SLIM Billing Block" (markdown)
  // Older: "SLIM BILLING" (all-caps plain text, used in Lexiscan sessions)
  if ((text.includes('SLIM Billing Block') || text.includes('SLIM BILLING')) &&
      text.includes('Date of Service:') &&
      text.includes('CPT:')) return true;

  // EPIC — ends after Patient Instructions (Spanish), no SLIM
  if (/^#\s+[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+(New Consultation|Established Follow-Up)/m.test(text) &&
      text.includes('## Patient Instructions (Spanish)')) return true;

  // Wellness Visit
  if (text.includes('Annual Wellness Statement') &&
      text.includes('## Patient Instructions (Spanish)')) return true;

  // CCM Telephone Call
  if (text.includes('CCM Telephone Call') &&
      text.includes('Total CCM minutes:')) return true;

  // New Patient Intake
  if (text.includes('NEW PATIENT INTAKE') &&
      text.includes('## Patient Instructions (Spanish)')) return true;

  // ECW Rhythm Monitoring — folder batch (# 1854-93224 - Rhythm Monitoring - MM/DD/YYYY)
  if (/^#\s+\d+-\d+\s+-\s+Rhythm Monitoring\s+-\s+\d{2}\/\d{2}\/\d{4}/m.test(text)) return true;

  // ECW Rhythm Monitoring — single patient 3-bullet format
  if (/^-\s+[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+.+:\s+[A-Z]{2,3}\s[A-Z]{2,3}\s+rhythm monitoring reviewed\./m.test(text)) return true;

  return false;
}

// ── Scan ALL assistant messages for completed notes ───────────────────────────
// Checking all messages (not just the last) lets us detect every patient in a
// multi-patient session and recover notes when navigating to existing conversations.
function checkForCompletedNotes() {
  const messages = getMessages();
  if (!messages.length) return;

  const assistantIdxs = messages
    .map((m, i) => m.role === 'assistant' ? i : -1)
    .filter(i => i >= 0);

  for (const msgIdx of assistantIdxs) {
    const text = messages[msgIdx].text;
    if (!isCompletedNote(text)) continue;

    const key = text.slice(-80);
    if (savedKeys.has(key)) continue;
    savedKeys.add(key);

    const payload = buildPayload(messages, assistantIdxs, msgIdx, text);
    chrome.runtime.sendMessage({ type: 'QUEUE_NOTE', payload });
  }
}

// ── Extract workflow metadata from completed note text ────────────────────────
function extractNoteMeta(noteText) {
  const today   = fmt(new Date());
  const slimDos = (noteText.match(/Date of Service:\s*(\d{2}\/\d{2}\/\d{4})/) || [])[1] || today;

  let m;

  m = noteText.match(/^#\s+([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+ECW Clinic/m);
  if (m) return { initials: m[1], workflow: 'ECW Clinic', dos: today };

  m = noteText.match(/^#\s+([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+(New Consultation|Established Follow-Up)/m);
  if (m) return { initials: m[1], workflow: 'EPIC', dos: today };

  m = noteText.match(/^#\s+([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+Wellness Visit/m);
  if (m) return { initials: m[1], workflow: 'Wellness Visit', dos: slimDos };

  m = noteText.match(/^#\s+([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+CCM Telephone Call\s+-\s+(\d{2}\/\d{2}\/\d{4})/m);
  if (m) return { initials: m[1], workflow: 'CCM Telephone Call', dos: m[2] };

  m = noteText.match(/^([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+NEW PATIENT INTAKE\s+-\s+(\d{2}\/\d{2}\/\d{4})/m);
  if (m) return { initials: m[1], workflow: 'New Patient Intake', dos: m[2] };

  m = noteText.match(/^#\s+(\d+-\d+)\s+-\s+Rhythm Monitoring\s+-\s+(\d{2}\/\d{2}\/\d{4})/m);
  if (m) return { initials: m[1], workflow: 'ECW Rhythm Monitoring', dos: m[2] };

  m = noteText.match(/^-\s+([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+/m);
  if (m && /rhythm monitoring reviewed/i.test(noteText)) {
    return { initials: m[1], workflow: 'ECW Rhythm Monitoring', dos: today };
  }

  const slimInitials = extractInitialsFromSlim(noteText);

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

  if (noteText.includes('SLIM Billing Block')) {
    return { initials: slimInitials, workflow: 'Cerner Note', dos: slimDos };
  }

  // Lexiscan (older ChartGPT format — "SLIM BILLING" all-caps plain text)
  if (noteText.includes('SLIM BILLING')) {
    return { initials: slimInitials, workflow: 'Lexiscan 93018', dos: slimDos };
  }

  return { initials: 'UNKNOWN', workflow: 'Clinical Note', dos: today };
}

// ── Build the payload for a specific assistant message ────────────────────────
// msgIdx is the position of this assistant message in the messages array.
// assistantIdxs lets us find the preceding assistant message so dictation
// capture is correct even in multi-patient sessions.
function buildPayload(messages, assistantIdxs, msgIdx, noteText) {
  const today = fmt(new Date());
  const { initials, workflow, dos } = extractNoteMeta(noteText);

  // Dictation = user messages between the PREVIOUS and CURRENT assistant response.
  // Handles multi-patient sessions correctly regardless of lazy DOM loading.
  const myPos  = assistantIdxs.indexOf(msgIdx);
  const prevIdx = myPos > 0 ? assistantIdxs[myPos - 1] : -1;

  const dictation = messages
    .slice(prevIdx + 1, msgIdx)
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
  // Handles 2-part (MEL PEA) and 3-part initials (ELY ACE GAR)
  const m = text.match(/Patient Initials:\s*([A-Z]{2,3}(?:\s[A-Z]{2,3}){1,2})/);
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
