"""
Generates a single combined PDF for the entire dispatch batch.
All notes are merged into one document (one page-break-separated section per note).
Rendered by Playwright (headless Chromium).
"""
import html
import json
import re
import sys
from datetime import datetime

from playwright.sync_api import sync_playwright


# ── OpenChatPDF-style CSS ─────────────────────────────────────────────────────

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
.note-section {
  margin-bottom: 3rem;
}
.note-section + .note-section {
  page-break-before: always;
  padding-top: 1rem;
}
.note-header {
  border-left: 4px solid #4a90e2;
  padding: 0.6rem 1.1rem;
  margin-bottom: 1.4rem;
  background: #f0f4ff;
  border-radius: 0 8px 8px 0;
}
.note-header .workflow {
  font-weight: 700;
  font-size: 1.05rem;
  color: #1a1a2e;
  display: block;
}
.note-header .meta {
  font-size: 0.85rem;
  color: #555;
}
.message {
  margin: 2.4rem 0;
  padding: 1.1rem 1.4rem;
  border-radius: 12px;
  position: relative;
}
.user {
  background: #e6f8ff;
  margin-left: 14%;
  border-top-right-radius: 0;
}
.assistant {
  background: #f4f4f7;
  margin-right: 14%;
  border-top-left-radius: 0;
}
.role {
  font-weight: 700;
  font-size: 0.95rem;
  margin-bottom: 0.6rem;
  color: #444;
}
pre {
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 1rem;
  border-radius: 8px;
  overflow-x: auto;
  white-space: pre-wrap;
}
code { font-family: 'Consolas', 'Monaco', monospace; }
img  { max-width: 100%; height: auto; }
h1, h2, h3, h4 { margin: 0.6em 0 0.3em 0; }
p  { margin: 0.4em 0; }
ul, ol { margin: 0.4em 0 0.4em 1.4em; }
li { margin: 0.15em 0; }
"""


# ── Simple markdown → HTML (enough for clinical notes) ───────────────────────

def md_to_html(text):
    lines = text.split("\n")
    out, in_ul = [], False

    def close():
        nonlocal in_ul
        if in_ul:
            out.append("</ul>")
            in_ul = False

    def inline(s):
        s = html.escape(s)
        s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
        s = re.sub(r"\*(.+?)\*",     r"<em>\1</em>",         s)
        s = re.sub(r"`(.+?)`",       r"<code>\1</code>",     s)
        return s

    for line in lines:
        if line.startswith("#### "):
            close(); out.append(f"<h4>{inline(line[5:])}</h4>")
        elif line.startswith("### "):
            close(); out.append(f"<h3>{inline(line[4:])}</h3>")
        elif line.startswith("## "):
            close(); out.append(f"<h2>{inline(line[3:])}</h2>")
        elif line.startswith("# "):
            close(); out.append(f"<h1>{inline(line[2:])}</h1>")
        elif line.startswith("- ") or line.startswith("* "):
            if not in_ul:
                out.append("<ul>"); in_ul = True
            out.append(f"<li>{inline(line[2:])}</li>")
        elif not line.strip():
            close(); out.append("<br>")
        else:
            close(); out.append(f"<p>{inline(line)}</p>")

    close()
    return "\n".join(out)


# ── Build one note section ────────────────────────────────────────────────────

def build_note_section(note):
    workflow  = note["workflow_type"]
    initials  = note["patient_initials"]
    dos       = note.get("date_of_service", "")
    dictation = note.get("dictation", "")
    content   = note["note_content"]

    dicts = [s.strip() for s in (dictation or "").split("\n---\n") if s.strip()]

    section = f"""
  <div class="note-section">
    <div class="note-header">
      <span class="workflow">{html.escape(workflow)}</span>
      <span class="meta">{html.escape(initials)} &nbsp;·&nbsp; {html.escape(dos)}</span>
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
      {md_to_html(content)}
    </div>
  </div>
"""
    return section


# ── Build the full combined HTML page ────────────────────────────────────────

def build_combined_html(notes, session_label):
    count = len(notes)
    note_word = "note" if count == 1 else "notes"
    sections = "\n".join(build_note_section(n) for n in notes)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>ChartGPT Session Notes — {html.escape(session_label)}</title>
<style>{OPENCHATPDF_CSS}</style>
</head>
<body>
  <h1 style="text-align:center; margin-bottom:0.4rem;">ChartGPT Session Notes</h1>
  <div style="font-size:0.9rem; text-align:center; color:#777; margin-bottom:2.5rem;">
    {count} {note_word} &nbsp;·&nbsp; {html.escape(session_label)}
  </div>
  {sections}
</body>
</html>"""


# ── Render HTML → PDF via Playwright (headless Chromium) ─────────────────────

def render_pdf(html_str, out_path):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.set_content(html_str, wait_until="domcontentloaded")
        page.pdf(path=out_path, format="Letter", print_background=True)
        browser.close()


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    data  = json.loads(sys.stdin.read())
    notes = data["notes"] if "notes" in data else [data]
    if not notes:
        print("No notes in payload — nothing to do.")
        return

    session = notes[0].get("session_date", data.get("session_date", ""))
    dt      = datetime.strptime(session, "%m/%d/%Y")
    year    = dt.strftime("%Y")
    month   = dt.strftime("%B")
    date_dir = dt.strftime("%m-%d-%Y")
    saved_on = dt.strftime("%B %d, %Y")

    filename     = f"ChartGPT_Notes_{date_dir}.pdf"
    onedrive_dir = f"ChartGPT Notes/{year}/{month}/{date_dir}"
    pdf_path     = f"/tmp/{filename}"

    page_html = build_combined_html(notes, saved_on)
    render_pdf(page_html, pdf_path)

    with open("/tmp/uploads.txt", "w") as f:
        f.write(f"{pdf_path}|{onedrive_dir}\n")

    print(f"Created: {pdf_path} ({len(notes)} notes) → {onedrive_dir}/{filename}")


if __name__ == "__main__":
    main()
