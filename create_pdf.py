"""
Generates PDFs using OpenChatPDF's exact HTML/CSS structure,
rendered by Playwright (headless Chromium) for identical output.
"""
import html
import json
import re
import sys
from datetime import datetime

from playwright.sync_api import sync_playwright


# ── OpenChatPDF CSS (verbatim from Khan-1291/OpenChatPDF, MIT) ────────────────

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


# ── Build the full HTML page ──────────────────────────────────────────────────

def build_html(workflow, initials, dos, dictation, note_content, saved_on):
    dicts = [s.strip() for s in (dictation or "").split("\n---\n") if s.strip()]

    messages_html = ""

    # Physician dictation → "You" bubbles (user style)
    for d in dicts:
        messages_html += f"""
        <div class="message user">
          <div class="role">Physician Dictation</div>
          <p>{html.escape(d)}</p>
        </div>"""

    # Generated note → "ChatGPT" bubble (assistant style)
    messages_html += f"""
    <div class="message assistant">
      <div class="role">ChartGPT</div>
      {md_to_html(note_content)}
    </div>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>{html.escape(workflow)} — {html.escape(initials)}</title>
<style>{OPENCHATPDF_CSS}</style>
</head>
<body>
  <h1 style="text-align:center; margin-bottom:0.4rem;">{html.escape(workflow)}</h1>
  <div style="font-size:0.9rem; text-align:center; color:#777; margin-bottom:2rem;">
    {html.escape(initials)} &nbsp;·&nbsp; {html.escape(dos)} &nbsp;·&nbsp; Saved {saved_on}
  </div>
  {messages_html}
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


# ── Utilities ─────────────────────────────────────────────────────────────────

def safe(text):
    return re.sub(r"[^\w\-]", "_", text).strip("_")


def main():
    data = json.loads(sys.stdin.read())
    notes = data["notes"] if "notes" in data else [data]
    uploads = []

    for note in notes:
        workflow  = note["workflow_type"]
        initials  = note["patient_initials"]
        dos       = note.get("date_of_service", "")
        dictation = note.get("dictation", "")
        content   = note["note_content"]
        session   = note.get("session_date", data.get("session_date"))

        dt        = datetime.strptime(session, "%m/%d/%Y")
        year      = dt.strftime("%Y")
        month     = dt.strftime("%B")
        date_dir  = dt.strftime("%m-%d-%Y")
        saved_on  = dt.strftime("%B %d, %Y")

        filename     = f"{safe(workflow)}_{safe(initials)}.pdf"
        onedrive_dir = f"ChartGPT Notes/{year}/{month}/{date_dir}"
        pdf_path     = f"/tmp/{filename}"

        page_html = build_html(workflow, initials, dos, dictation, content, saved_on)
        render_pdf(page_html, pdf_path)

        uploads.append(f"{pdf_path}|{onedrive_dir}")
        print(f"Created: {pdf_path} → {onedrive_dir}/{filename}")

    with open("/tmp/uploads.txt", "w") as f:
        f.write("\n".join(uploads))


if __name__ == "__main__":
    main()
