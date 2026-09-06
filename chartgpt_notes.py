#!/usr/bin/env python3
"""
chartgpt_notes.py — split a ChatGPT/ChartGPT conversation into finalized clinical notes
and render them as a single combined PDF.

Accepts on stdin (from GitHub Actions):
  { "conversation": <mapping object> }   — raw JSON from injector.js intercept
  { "notes": [ ... ] }                   — legacy format from extension queue flush

CLI usage (local batch):
  python chartgpt_notes.py <input.json|input.md> [--out DIR] [--pdf output.pdf]

Input formats auto-detected:
  * /backend-api/conversation/<id> JSON (object with "mapping" + "current_node")
  * OpenAI data-export conversations.json (list of those objects)
  * ChatGPT-Exporter markdown ("## Prompt:" / "## Response:" sections)
"""

import argparse
import datetime
import hashlib
import html
import json
import pathlib
import re
import sys


# ─────────────────────────── 1. load messages ────────────────────────────────

def messages_from_mapping(conv):
    """Walk current_node → root. Returns [{id, role, text, create_time}]."""
    mapping = conv.get("mapping") or {}
    node    = conv.get("current_node")
    out = []
    while node and node in mapping:
        n = mapping[node]
        m = n.get("message") or {}
        role  = (m.get("author") or {}).get("role")
        parts = (m.get("content") or {}).get("parts") or []
        text  = "\n".join(p for p in parts if isinstance(p, str)).strip()
        if text and role in ("user", "assistant"):
            out.append({
                "id":          m.get("id") or node,
                "role":        role,
                "text":        text,
                "create_time": m.get("create_time"),
            })
        node = n.get("parent")
    out.reverse()
    return out


def messages_from_exporter_md(md):
    chunks = re.split(r"^## (Prompt|Response):\n[^\n]*\n\n", md, flags=re.M)
    out = []
    for i in range(1, len(chunks), 2):
        role = "user" if chunks[i] == "Prompt" else "assistant"
        text = chunks[i + 1].strip()
        text = re.sub(r"\n+---\nPowered by \[ChatGPT Exporter\].*$", "", text, flags=re.S)
        out.append({
            "id":   hashlib.sha1(text.encode()).hexdigest()[:12],
            "role": role,
            "text": text,
            "create_time": None,
        })
    return out


def load_file(path):
    raw = pathlib.Path(path).read_text(encoding="utf-8")
    if raw.lstrip().startswith(("{", "[")):
        data  = json.loads(raw)
        convs = data if isinstance(data, list) else [data]
        return [(c.get("conversation_id") or c.get("id") or "conv",
                 messages_from_mapping(c)) for c in convs]
    return [(pathlib.Path(path).stem, messages_from_exporter_md(raw))]


# ─────────────────────────── 2. canonical text ───────────────────────────────

def _strip_chatgpt_artifacts(text):
    """Remove ChatGPT-specific noise (cite markers, file chips) without
    touching markdown formatting — shared by canonical() and pdf_text()."""
    t = text.replace("\r", "")
    t = re.sub(r"\uE200.*?\uE201", "", t)              # private-use cite spans
    t = re.sub(r"filecite\S*", "", t)                    # fileciteXXX
    t = re.sub(r"\bturn\d+file\d+\b", "", t)          # turn0file0
    t = re.sub(r"^Held `[^`]*`\s*$", "", t, flags=re.M)
    t = re.sub(r"`[A-Za-z0-9_./-]+\.md`", "", t)
    t = t.replace("\u00a0", " ")
    t = re.sub(r"[ \t]+\n", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t


def canonical(text):
    """Plain text used for detection and metadata — strips all markdown formatting
    so patterns work on both raw API markdown and DOM innerText."""
    t = _strip_chatgpt_artifacts(text)
    t = re.sub(r"\*\*|__", "", t)
    t = re.sub(r"^#{1,6}\s*", "", t, flags=re.M)
    t = re.sub(r"^\s*[-*\u2022]\s+", "", t, flags=re.M)
    t = t.replace("\u2013", "-").replace("\u2014", "-")
    return t.strip()


def pdf_text(text):
    """Markdown preserved for PDF rendering — only ChatGPT artifacts removed.
    ## headings and bullet lists survive so md_to_html() formats them."""
    t = _strip_chatgpt_artifacts(text)
    t = t.replace("\u2013", "-").replace("\u2014", "-")
    return t.strip()


# ─────────────────────────── 3. detect + metadata ────────────────────────────

INITIALS = r"[A-Z]{2,3}(?: [A-Z]{2,3}){1,2}"
DATE     = r"\d{2}/\d{2}/\d{4}"


def kv(text, label):
    m = re.search(rf"^{label}:\s*(.+?)\s*$", text, flags=re.M | re.I)
    return m.group(1).strip() if m else None


def is_final(t):
    if "FINAL-OK TO PRINT" in t:
        return True
    if (re.search(r"^SLIM Billing Block|^SLIM BILLING", t, re.M)
            and kv(t, "Date of Service") and kv(t, "CPT")):
        return True
    if (re.search(r"Stress Test Supervision Report", t)
            and kv(t, "Date of Service")
            and re.search(r"^CPT:\s*93018", t, re.M)):
        return True
    if (re.search(rf"^{INITIALS} - (New Consultation|Established Follow-Up)", t, re.M)
            and "Patient Instructions (Spanish)" in t):
        return True
    if "Annual Wellness Statement" in t and "Patient Instructions (Spanish)" in t:
        return True
    if "CCM Telephone Call" in t and "Total CCM minutes:" in t:
        return True
    if "NEW PATIENT INTAKE" in t and "Patient Instructions (Spanish)" in t:
        return True
    if re.search(rf"^\d+-\d+ - Rhythm Monitoring - {DATE}", t, re.M):
        return True
    if re.search(rf"^{INITIALS} - .+:\s+{INITIALS} rhythm monitoring reviewed\.", t, re.M):
        return True
    return False


WORKFLOWS = [
    (r"ECW Clinic",                                                            "ECW Clinic"),
    (r"New Consultation|Established Follow-Up",                                "EPIC"),
    (r"Wellness Visit",                                                        "Wellness Visit"),
    (r"CCM Telephone Call",                                                    "CCM Telephone Call"),
    (r"NEW PATIENT INTAKE",                                                    "New Patient Intake"),
    (r"Pharmacologic .*Stress Test",                                           "Lexiscan 93018"),
    (r"Inpatient Cardiology Consult",                                          "Cerner Consult"),
    (r"Inpatient Cardiology Progress",                                         "Cerner Rounds"),
    (r"Pre-Procedure|Pacemaker|Defibrillator|Loop Recorder|Cardioversion"
     r"|Cardiac Catheterization",                                              "Cerner Procedure"),
    (r"Transesophageal Echocardiogram|TEE",                                    "TEE Report"),
    (r"Tilt Table",                                                            "Tilt Table Test"),
    (r"Rhythm Monitoring",                                                     "ECW Rhythm Monitoring"),
]


def extract_workflow(heading):
    for rx, name in WORKFLOWS:
        if re.search(rx, heading, re.I):
            return name
    return None


def metadata(t, session_date):
    title    = re.search(rf"^({INITIALS}) - (.+)$", t, re.M)
    initials = kv(t, "Patient Initials") or (title.group(1) if title else None)
    heading  = title.group(2) if title else ""
    workflow = extract_workflow(heading)
    if not workflow:
        workflow = "Cerner Note" if "SLIM Billing" in t else "Clinical Note"
    dos = kv(t, "Date of Service")
    if not dos:
        m = re.search(rf"^{INITIALS} - .+? - ({DATE})", t, re.M)
        dos = m.group(1) if m else session_date
    return {
        "patient_initials": initials or "UNKNOWN",
        "workflow_type":    workflow,
        "date_of_service":  dos,
        "encounter_type":   kv(t, "Encounter Type"),
        "cpt":              ", ".join(re.findall(r"\b\d{5}\b", kv(t, "CPT") or "")) or None,
        "mrn":              kv(t, "MRN"),
        "fin":              kv(t, "FIN"),
    }


# ─────────────────────────── 4. split conversation ───────────────────────────

def split_notes(conv_id, msgs, session_date):
    notes, last_assistant = [], -1
    for i, m in enumerate(msgs):
        if m["role"] != "assistant":
            continue
        raw = m["text"]
        t   = canonical(raw)       # plain text — for detection and metadata only
        if is_final(t):
            dictation = "\n---\n".join(
                canonical(u["text"]) for u in msgs[last_assistant + 1:i]
                if u["role"] == "user"
            )
            meta = metadata(t, session_date)
            meta.update({
                "conversation_id": conv_id,
                "message_id":      m["id"],
                "session_date":    session_date,
                "dictation":       dictation,
                "note_content":    pdf_text(raw),   # markdown preserved for PDF
                "dedup_key":       f"{conv_id}:{m['id']}",
            })
            notes.append(meta)
        last_assistant = i
    return notes


def notes_from_legacy(notes_array, session_date):
    """Convert the extension's legacy notes array into our note format."""
    out = []
    for i, n in enumerate(notes_array):
        raw_text = n.get("note_content", "")
        t = canonical(raw_text)
        meta = metadata(t, session_date)
        # Trust the extension's metadata where it's not UNKNOWN
        if n.get("patient_initials") and n["patient_initials"] != "UNKNOWN":
            meta["patient_initials"] = n["patient_initials"]
        if n.get("workflow_type") and n["workflow_type"] != "Clinical Note":
            meta["workflow_type"] = n["workflow_type"]
        if n.get("date_of_service"):
            meta["date_of_service"] = n["date_of_service"]
        meta.update({
            "conversation_id": "queue",
            "message_id":      str(i),
            "session_date":    n.get("session_date", session_date),
            "dictation":       n.get("dictation", ""),
            "note_content":    t,
            "dedup_key":       f"queue:{i}",
        })
        out.append(meta)
    return out


# ─────────────────────────── 5. PDF generation ───────────────────────────────

OPENCHATPDF_CSS = """
@page { margin: 1.8cm 1.6cm; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  line-height: 1.58;
  color: #111;
  max-width: 900px;
  margin: 0 auto;
  padding: 1rem 0;
}
.note-section { margin-bottom: 3rem; }
.note-section + .note-section { page-break-before: always; padding-top: 1rem; }
.note-header {
  border-left: 4px solid #4a90e2;
  padding: 0.6rem 1.1rem;
  margin-bottom: 1.4rem;
  background: #f0f4ff;
  border-radius: 0 8px 8px 0;
}
.note-header .workflow { font-weight: 700; font-size: 1.05rem; color: #1a1a2e; display: block; }
.note-header .meta { font-size: 0.85rem; color: #555; }
.message { margin: 2.4rem 0; padding: 1.1rem 1.4rem; border-radius: 12px; }
.user      { background: #e6f8ff; margin-left: 14%; border-top-right-radius: 0; }
.assistant { background: #f4f4f7; margin-right: 14%; border-top-left-radius: 0; }
.role { font-weight: 700; font-size: 0.95rem; margin-bottom: 0.6rem; color: #444; }
pre  { background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 8px;
       overflow-x: auto; white-space: pre-wrap; }
code { font-family: 'Consolas','Monaco',monospace; }
img  { max-width: 100%; height: auto; }
h1,h2,h3,h4 { margin: 0.6em 0 0.3em 0; }
p    { margin: 0.4em 0; }
ul,ol { margin: 0.4em 0 0.4em 1.4em; }
li   { margin: 0.15em 0; }
"""


def md_to_html(text):
    """Minimal markdown → HTML for clinical note rendering."""
    lines = text.split("\n")
    out, in_ul = [], False

    def close_ul():
        nonlocal in_ul
        if in_ul:
            out.append("</ul>"); in_ul = False

    def inline(s):
        s = html.escape(s)
        s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
        s = re.sub(r"\*(.+?)\*",     r"<em>\1</em>",         s)
        s = re.sub(r"`(.+?)`",       r"<code>\1</code>",     s)
        return s

    for line in lines:
        if   line.startswith("#### "): close_ul(); out.append(f"<h4>{inline(line[5:])}</h4>")
        elif line.startswith("### "):  close_ul(); out.append(f"<h3>{inline(line[4:])}</h3>")
        elif line.startswith("## "):   close_ul(); out.append(f"<h2>{inline(line[3:])}</h2>")
        elif line.startswith("# "):    close_ul(); out.append(f"<h1>{inline(line[2:])}</h1>")
        elif line.startswith("- ") or line.startswith("* "):
            if not in_ul: out.append("<ul>"); in_ul = True
            out.append(f"<li>{inline(line[2:])}</li>")
        elif not line.strip():
            close_ul(); out.append("<br>")
        else:
            close_ul(); out.append(f"<p>{inline(line)}</p>")
    close_ul()
    return "\n".join(out)


def build_section(note):
    dicts = [s.strip() for s in (note.get("dictation") or "").split("\n---\n") if s.strip()]
    section = f"""
  <div class="note-section">
    <div class="note-header">
      <span class="workflow">{html.escape(note['workflow_type'])}</span>
      <span class="meta">{html.escape(note['patient_initials'])} &nbsp;·&nbsp; {html.escape(note['date_of_service'])}</span>
    </div>
"""
    for d in dicts:
        section += f"""
    <div class="message user">
      <div class="role">Physician Dictation</div>
      <p>{html.escape(d)}</p>
    </div>"""

    section += f"""
    <div class="message assistant">
      <div class="role">ChartGPT</div>
      {md_to_html(note['note_content'])}
    </div>
  </div>
"""
    return section


def build_combined_html(notes, session_label):
    n = len(notes)
    sections = "\n".join(build_section(note) for note in notes)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>ChartGPT Session Notes — {html.escape(session_label)}</title>
<style>{OPENCHATPDF_CSS}</style>
</head>
<body>
  <h1 style="text-align:center;margin-bottom:.4rem;">ChartGPT Session Notes</h1>
  <div style="font-size:.9rem;text-align:center;color:#777;margin-bottom:2.5rem;">
    {n} note{'s' if n != 1 else ''} &nbsp;·&nbsp; {html.escape(session_label)}
  </div>
  {sections}
</body>
</html>"""


def render_pdf(html_str, out_path):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page    = browser.new_page()
        page.set_content(html_str, wait_until="domcontentloaded")
        page.pdf(path=out_path, format="Letter", print_background=True)
        browser.close()


# ─────────────────────────── 6. utilities ────────────────────────────────────

def safe(s):
    return re.sub(r"[^A-Za-z0-9]+", "_", s or "UNKNOWN").strip("_")


def parse_session_date(s):
    try:
        return datetime.datetime.strptime(s, "%m/%d/%Y")
    except (ValueError, TypeError):
        return datetime.datetime.today()


# ─────────────────────────── 7. main ─────────────────────────────────────────

def run_github_actions(pdf_only=False):
    """
    Called when reading from stdin (GitHub Actions mode).
    Payload is either:
      { "conversation": <mapping obj> }   ← injector.js raw JSON
      { "notes": [ ... ] }                ← legacy queue flush
    """
    raw  = sys.stdin.read()
    data = json.loads(raw)
    today = datetime.date.today().strftime("%m/%d/%Y")

    if "conversation" in data:
        conv   = data["conversation"]
        conv_id = conv.get("conversation_id") or "conv"
        msgs   = messages_from_mapping(conv)
        notes  = split_notes(conv_id, msgs, today)
    elif "notes" in data:
        notes = notes_from_legacy(data["notes"], today)
    else:
        print("Unrecognized payload — expected 'conversation' or 'notes'.", file=sys.stderr)
        sys.exit(1)

    if not notes:
        print("No completed notes detected.")
        pathlib.Path("/tmp/uploads.txt").write_text("")
        return

    session = notes[0].get("session_date", today)
    dt      = parse_session_date(session)
    year    = dt.strftime("%Y")
    month   = dt.strftime("%B")
    date_dir = dt.strftime("%m-%d-%Y")
    saved_on = dt.strftime("%B %d, %Y")

    filename     = f"ChartGPT_Notes_{date_dir}.pdf"
    onedrive_dir = f"ChartGPT Notes/{year}/{month}/{date_dir}"
    pdf_path     = f"/tmp/{filename}"

    page_html = build_combined_html(notes, saved_on)
    render_pdf(page_html, pdf_path)

    pathlib.Path("/tmp/uploads.txt").write_text(f"{pdf_path}|{onedrive_dir}\n")
    print(f"Created: {pdf_path} ({len(notes)} notes) → {onedrive_dir}/{filename}")
    for n in notes:
        print(f"  {n['patient_initials']:<12} {n['workflow_type']:<20} {n['date_of_service']}  CPT {n['cpt']}")


def run_cli():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input")
    ap.add_argument("--out",  default="notes_out", help="output directory for .md files")
    ap.add_argument("--pdf",  default=None,         help="path for combined PDF (optional)")
    a = ap.parse_args()

    out   = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    today = datetime.date.today().strftime("%m/%d/%Y")
    all_notes = []

    for conv_id, msgs in load_file(a.input):
        for n in split_notes(conv_id, msgs, today):
            all_notes.append(n)
            fname = (f"{safe(n['patient_initials'])}_{safe(n['workflow_type'])}_"
                     f"{n['date_of_service'].replace('/', '')}_{n['message_id'][:8]}.md")
            body = (f"{n['workflow_type']}\n{n['patient_initials']} · {n['date_of_service']}\n\n"
                    f"Physician Dictation\n{n['dictation']}\n\nChartGPT\n{n['note_content']}\n")
            (out / fname).write_text(body, encoding="utf-8")

    manifest = [{k: v for k, v in n.items() if k not in ("dictation", "note_content")}
                | {"file": f"{safe(n['patient_initials'])}_{safe(n['workflow_type'])}_"
                           f"{n['date_of_service'].replace('/', '')}_{n['message_id'][:8]}.md"}
                for n in all_notes]
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))

    for n in all_notes:
        print(f"{n['patient_initials']:<12} {n['workflow_type']:<20} {n['date_of_service']}  CPT {n['cpt']}")
    print(f"{len(all_notes)} notes → {out}/")

    if a.pdf and all_notes:
        dt = parse_session_date(today)
        page_html = build_combined_html(all_notes, dt.strftime("%B %d, %Y"))
        render_pdf(page_html, a.pdf)
        print(f"PDF → {a.pdf}")


if __name__ == "__main__":
    if sys.stdin.isatty():
        run_cli()
    else:
        run_github_actions()
