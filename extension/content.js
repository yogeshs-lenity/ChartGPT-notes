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

  // injector.js (MAIN world, document_start) intercepts ChatGPT's own fetch call
  // and stores the full conversation JSON in window.__cgn_conv__ — no auth
  // header issues because we piggyback on the request the page already makes.
  (async () => {
    // Give the page's fetch a moment to complete and the cache to populate
    await new Promise(r => setTimeout(r, 800));

    let convData = window.__cgn_conv__;

    // Fallback: direct API call (bearer token from /api/auth/session)
    if (!convData) {
      const convId = location.pathname.match(/\/c\/([a-f0-9-]+)/)?.[1];
      if (convId) {
        try { convData = await fetchFullConversation(convId); } catch {}
      }
    }

    if (convData) {
      // Send raw JSON to background — server-side chartgpt_notes.py does all
      // detection/extraction on canonical text (no V1/V2 regex duplication).
      chrome.runtime.sendMessage({ type: 'RAW_CONV', data: convData }).catch(() => {});
      // Also process for real-time queue display in popup
      const messages = flattenConversation(convData);
      if (messages.length) {
        processMessages(messages);
        chrome.runtime.sendMessage({ type: 'SCAN_DONE', count: savedKeys.size }).catch(() => {});
        return;
      }
    }

    // Final fallback: DOM scan
    await new Promise(r => setTimeout(r, 2500));
    checkForCompletedNotes();
    chrome.runtime.sendMessage({ type: 'SCAN_DONE', count: savedKeys.size }).catch(() => {});
  })();

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
// NOTE: ChatGPT V2 renders markdown headings as HTML (<h2> etc.), so innerText
// strips the leading # chars. All heading patterns use #?\s* to match both.
// "## Patient Instructions (Spanish)" → "Patient Instructions (Spanish)" in V2,
// so those string checks also drop the ## prefix.
function isCompletedNote(text) {
  // ECW Clinic
  if (text.includes('FINAL-OK TO PRINT')) return true;

  // Cerner / Lexiscan — two SLIM formats:
  // V10 markdown: "## SLIM Billing Block" → rendered as "SLIM Billing Block"
  // Older plain text: "SLIM BILLING"
  if ((text.includes('SLIM Billing Block') || text.includes('SLIM BILLING')) &&
      text.includes('Date of Service:') &&
      text.includes('CPT:')) return true;

  // Lexiscan supervision report (no SLIM block at all — just CPT 93018)
  if (/Pharmacologic (?:Nuclear )?Stress Test Supervision Report/.test(text) &&
      text.includes('Date of Service:') && /CPT:\s*93018/.test(text)) return true;

  // EPIC — ends after Patient Instructions (Spanish), no SLIM
  if (/^#?\s*[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+(New Consultation|Established Follow-Up)/m.test(text) &&
      text.includes('Patient Instructions (Spanish)')) return true;

  // Wellness Visit
  if (text.includes('Annual Wellness Statement') &&
      text.includes('Patient Instructions (Spanish)')) return true;

  // CCM Telephone Call
  if (text.includes('CCM Telephone Call') &&
      text.includes('Total CCM minutes:')) return true;

  // New Patient Intake
  if (text.includes('NEW PATIENT INTAKE') &&
      text.includes('Patient Instructions (Spanish)')) return true;

  // ECW Rhythm Monitoring — folder batch
  if (/^#?\s*\d+-\d+\s+-\s+Rhythm Monitoring\s+-\s+\d{2}\/\d{2}\/\d{4}/m.test(text)) return true;

  // ECW Rhythm Monitoring — single patient (V1: "- XX XX - ..." / V2: "XX XX - ...")
  if (/^[-•]?\s*[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+.+:\s+[A-Z]{2,3}\s[A-Z]{2,3}\s+rhythm monitoring reviewed\./m.test(text)) return true;

  return false;
}

// ── Fetch the full conversation from ChatGPT's internal API ──────────────────
// Cookies alone return 404 "conversation_inaccessible" — the bearer token from
// /api/auth/session is required (confirmed by ChatGPT Exporter source).
async function fetchFullConversation(convId) {
  // Step 1: get bearer token from the session endpoint
  let token = '';
  let accountId = '';
  try {
    const s = await fetch('/api/auth/session', { credentials: 'include' });
    if (s.ok) {
      const d = await s.json();
      token = d?.accessToken || '';
    }
  } catch {}

  const authHeaders = (id = '') => {
    const h = { Accept: 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    if (id) h['ChatGPT-Account-Id'] = id;
    return h;
  };

  // Step 2: fetch the conversation (with optional workspace account retry)
  const url = `/backend-api/conversation/${encodeURIComponent(convId)}`;
  let resp = await fetch(url, { credentials: 'include', headers: authHeaders() });

  // Workspace members need ChatGPT-Account-Id; try each account on auth failure
  if ((resp.status === 401 || resp.status === 403 || resp.status === 404) && token) {
    try {
      const ar = await fetch('/backend-api/accounts/check/v4-2023-04-27', {
        credentials: 'include',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (ar.ok) {
        const ap = await ar.json();
        const ids = Object.values(ap?.accounts || {}).map(e => e?.account?.account_id).filter(Boolean);
        for (const id of ids) {
          resp = await fetch(url, { credentials: 'include', headers: authHeaders(id) });
          if (resp.ok) break;
        }
      }
    } catch {}
  }

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// Walk the message tree from current_node → root to reconstruct the linear thread.
function flattenConversation(data) {
  const { mapping, current_node } = data;
  if (!mapping || !current_node) return [];
  const msgs = [];
  let nodeId = current_node;
  while (nodeId && mapping[nodeId]) {
    const node = mapping[nodeId];
    const msg  = node.message;
    if (msg?.author && msg?.content) {
      const role  = msg.author.role;
      const parts = msg.content.parts || [];
      const text  = parts.filter(p => typeof p === 'string').join('\n').trim();
      if (text && (role === 'user' || role === 'assistant')) msgs.unshift({ role, text });
    }
    nodeId = node.parent;
  }
  return msgs;
}

// ── Core scanner — works with any message array ────────────────────────────────
function processMessages(messages) {
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
    chrome.runtime.sendMessage({ type: 'QUEUE_NOTE', payload: buildPayload(messages, assistantIdxs, msgIdx, text) });
  }
}

// DOM-based scan — used by MutationObserver for real-time detection
function checkForCompletedNotes() { processMessages(getMessages()); }

// ── Extract workflow metadata from completed note text ────────────────────────
// Patterns use #?\s* instead of #\s+ so they match both V1 (markdown source with #)
// and V2 (HTML-rendered, # stripped by innerText).
function extractNoteMeta(noteText) {
  const today   = fmt(new Date());
  const slimDos = (noteText.match(/Date of Service:\s*(\d{2}\/\d{2}\/\d{4})/) || [])[1] || today;

  let m;

  m = noteText.match(/^#?\s*([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+ECW Clinic/m);
  if (m) return { initials: m[1], workflow: 'ECW Clinic', dos: today };

  m = noteText.match(/^#?\s*([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+(New Consultation|Established Follow-Up)/m);
  if (m) return { initials: m[1], workflow: 'EPIC', dos: today };

  m = noteText.match(/^#?\s*([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+Wellness Visit/m);
  if (m) return { initials: m[1], workflow: 'Wellness Visit', dos: slimDos };

  m = noteText.match(/^#?\s*([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+CCM Telephone Call\s+-\s+(\d{2}\/\d{2}\/\d{4})/m);
  if (m) return { initials: m[1], workflow: 'CCM Telephone Call', dos: m[2] };

  m = noteText.match(/^([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+NEW PATIENT INTAKE\s+-\s+(\d{2}\/\d{2}\/\d{4})/m);
  if (m) return { initials: m[1], workflow: 'New Patient Intake', dos: m[2] };

  m = noteText.match(/^#?\s*(\d+-\d+)\s+-\s+Rhythm Monitoring\s+-\s+(\d{2}\/\d{2}\/\d{4})/m);
  if (m) return { initials: m[1], workflow: 'ECW Rhythm Monitoring', dos: m[2] };

  m = noteText.match(/^[-•]?\s*([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+/m);
  if (m && /rhythm monitoring reviewed/i.test(noteText)) {
    return { initials: m[1], workflow: 'ECW Rhythm Monitoring', dos: today };
  }

  const slimInitials = extractInitialsFromSlim(noteText);

  if (/^Cardiac Catheterization\s+-\s+\d{2}\/\d{2}\/\d{4}/m.test(noteText)) {
    return { initials: slimInitials, workflow: 'Cardiac Cath', dos: slimDos };
  }

  m = noteText.match(/^#?\s*[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+Tilt Table/m);
  if (m) return { initials: slimInitials, workflow: 'Tilt Table Test', dos: slimDos };

  // Lexiscan supervision report — no SLIM block, initials are in the note title line
  m = noteText.match(/^([A-Z]{2,3}\s[A-Z]{2,3})\s+-\s+Pharmacologic/m);
  if (m && /CPT:\s*93018/.test(noteText)) {
    return { initials: m[1], workflow: 'Lexiscan 93018', dos: slimDos };
  }

  m = noteText.match(/^#?\s*[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+Inpatient Cardiology Consult/m);
  if (m) return { initials: slimInitials, workflow: 'Cerner Consult', dos: slimDos };

  m = noteText.match(/^#?\s*[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+Inpatient Cardiology Progress/m);
  if (m) return { initials: slimInitials, workflow: 'Cerner Rounds', dos: slimDos };

  m = noteText.match(/^#?\s*[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+Pre-Procedure/m);
  if (m) return { initials: slimInitials, workflow: 'Cerner Procedure', dos: slimDos };

  m = noteText.match(/^#?\s*[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+Transesophageal Echocardiogram/m);
  if (m) return { initials: slimInitials, workflow: 'TEE Report', dos: slimDos };

  m = noteText.match(/^#?\s*[A-Z]{2,3}\s[A-Z]{2,3}\s+-\s+Permanent .+Pacemaker/m);
  if (m) return { initials: slimInitials, workflow: 'Cerner Procedure', dos: slimDos };

  if (noteText.includes('SLIM Billing Block')) {
    return { initials: slimInitials, workflow: 'Cerner Note', dos: slimDos };
  }

  // Lexiscan older format — "SLIM BILLING" all-caps plain text
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
