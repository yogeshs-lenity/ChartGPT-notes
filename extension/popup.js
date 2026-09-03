// ChartGPT Notes — popup dashboard

const $ = id => document.getElementById(id);

const D = {
  patBadge:        $('patBadge'),
  queueCount:      $('queueCount'),
  noteList:        $('noteList'),
  autoText:        $('autoText'),
  flushBtn:        $('flushBtn'),
  lastSentSection: $('lastSentSection'),
  lastSentBody:    $('lastSentBody'),
  lastSentLabel:   $('lastSentLabel'),
  lastSentTime:    $('lastSentTime'),
  resendBtn:       $('resendBtn'),
  patInput:        $('patInput'),
  savePatBtn:      $('savePatBtn'),
  toast:           $('toast'),
};

let state = { queue: [], hasPat: false, lastBatch: null };

// Load state from background on open
chrome.runtime.sendMessage({ type: 'GET_STATE' }, resp => {
  if (resp) { state = resp; render(); }
});

// Also pre-fill PAT field
chrome.storage.local.get('github_pat', ({ github_pat }) => {
  if (github_pat) D.patInput.value = github_pat;
});

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  // PAT badge
  if (state.hasPat) {
    D.patBadge.textContent = 'PAT ✓';
    D.patBadge.className = 'pat-badge ok';
  } else {
    D.patBadge.textContent = 'No PAT';
    D.patBadge.className = 'pat-badge err';
  }

  // Queue count + cards
  const q = state.queue;
  D.queueCount.textContent = q.length;
  D.flushBtn.disabled = q.length === 0;

  if (q.length === 0) {
    D.noteList.innerHTML = '<div class="queue-empty">No notes queued yet</div>';
  } else {
    D.noteList.innerHTML = q.map((note, i) => {
      const key = esc(note.note_content.slice(-80));
      return `
        <div class="note-card">
          <div class="note-initials">${esc(note.patient_initials)}</div>
          <div class="note-meta">
            <div class="note-workflow">${esc(note.workflow_type)}</div>
            <div class="note-dos">${esc(note.date_of_service)}</div>
          </div>
          <button class="remove-btn" data-key="${key}" title="Remove from queue">✕</button>
        </div>`;
    }).join('');

    D.noteList.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        chrome.runtime.sendMessage({ type: 'REMOVE_NOTE', key }, () => {
          state.queue = state.queue.filter(n => n.note_content.slice(-80) !== key);
          render();
          toast('Note removed');
        });
      });
    });
  }

  // Auto-save countdown
  renderAutoSave();

  // Last sent panel
  if (state.lastBatch) {
    D.lastSentSection.style.display = '';
    renderLastSent(state.lastBatch);
  } else {
    D.lastSentSection.style.display = 'none';
  }
}

function renderAutoSave() {
  const now  = new Date();
  const fire = new Date();
  fire.setHours(18, 0, 0, 0);
  if (fire <= now) fire.setDate(fire.getDate() + 1);

  const diff = fire - now;
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const label = h > 0 ? `in ${h}h ${m}m` : m > 0 ? `in ${m}m` : 'now';

  D.autoText.innerHTML = `Auto-saves <strong>${label}</strong>`;
}

function renderLastSent(batch) {
  const icon  = { sent: '✓', error: '✕', sending: '…' }[batch.status] || '…';
  const cls   = { sent: 'ok', error: 'err', sending: 'pending' }[batch.status] || 'pending';
  const label =
    batch.status === 'sent'    ? `${batch.count} note${batch.count !== 1 ? 's' : ''} dispatched` :
    batch.status === 'error'   ? `Failed — ${batch.error || 'unknown error'}` :
    'Sending…';

  D.lastSentBody.className = `last-sent-body ${cls}`;
  D.lastSentBody.querySelector('.last-sent-icon').textContent = icon;
  D.lastSentLabel.textContent = label;
  D.lastSentTime.textContent  = fmtTime(new Date(batch.sent_at));
  D.resendBtn.style.display   = batch.status !== 'sending' ? '' : 'none';
}

// ── Event handlers ────────────────────────────────────────────────────────────
D.flushBtn.addEventListener('click', () => {
  D.flushBtn.disabled    = true;
  D.flushBtn.textContent = 'Sending…';
  chrome.runtime.sendMessage({ type: 'FLUSH_NOW' }, () => {
    toast('Dispatched to GitHub Actions ✓');
    setTimeout(refreshState, 1200);
  });
});

D.resendBtn.addEventListener('click', () => {
  D.resendBtn.disabled    = true;
  D.resendBtn.textContent = '…';
  chrome.runtime.sendMessage({ type: 'RESEND_LAST' }, () => {
    toast('Resent to GitHub Actions ✓');
    setTimeout(() => {
      D.resendBtn.disabled    = false;
      D.resendBtn.textContent = 'Resend';
      refreshState();
    }, 1200);
  });
});

D.savePatBtn.addEventListener('click', () => {
  const pat = D.patInput.value.trim();
  if (!pat) { toast('Enter a PAT first', true); return; }
  chrome.storage.local.set({ github_pat: pat }, () => {
    state.hasPat = true;
    render();
    toast('PAT saved ✓');
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function refreshState() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, resp => {
    if (resp) { state = resp; render(); }
  });
}

function toast(msg, isError = false) {
  D.toast.textContent = msg;
  D.toast.style.borderColor = isError ? 'var(--error)' : 'var(--border)';
  D.toast.classList.add('show');
  clearTimeout(D.toast._t);
  D.toast._t = setTimeout(() => D.toast.classList.remove('show'), 2400);
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(date) {
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return `Today at ${time}`;
  if (date.toDateString() === new Date(now - 86400000).toDateString()) return `Yesterday at ${time}`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${time}`;
}

// Update countdown every minute while popup is open
setInterval(renderAutoSave, 60000);
