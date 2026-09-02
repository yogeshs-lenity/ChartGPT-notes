import html
import json
import os
import re
import sys
from datetime import datetime

from weasyprint import HTML


# ── Markdown → HTML ────────────────────────────────────────────────────────────

def md_inline(text):
    """Convert **bold** markers to <strong> and escape everything else."""
    parts = re.split(r"(\*\*[^*]+\*\*)", html.escape(text))
    out = []
    for p in parts:
        if p.startswith("**") and p.endswith("**"):
            out.append(f"<strong>{p[2:-2]}</strong>")
        else:
            out.append(p)
    return "".join(out)


def md_to_html(md):
    lines = md.split("\n")
    buf = []
    in_ul = False

    def close_ul():
        nonlocal in_ul
        if in_ul:
            buf.append("</ul>")
            in_ul = False

    for line in lines:
        if line.startswith("# "):
            close_ul()
            buf.append(f'<h1>{md_inline(line[2:].strip())}</h1>')
        elif line.startswith("## "):
            close_ul()
            buf.append(f'<h2>{md_inline(line[3:].strip())}</h2>')
        elif line.startswith("### "):
            close_ul()
            buf.append(f'<h3>{md_inline(line[4:].strip())}</h3>')
        elif line.startswith("#### "):
            close_ul()
            buf.append(f'<h4>{md_inline(line[5:].strip())}</h4>')
        elif line.startswith("- "):
            if not in_ul:
                buf.append("<ul>")
                in_ul = True
            buf.append(f'<li>{md_inline(line[2:].strip())}</li>')
        elif re.match(r"^\d+\. ", line):
            close_ul()
            buf.append(f'<li>{md_inline(re.sub(r"^\d+\.\s*", "", line))}</li>')
        elif not line.strip():
            close_ul()
            buf.append('<div class="spacer"></div>')
        else:
            close_ul()
            buf.append(f'<p>{md_inline(line)}</p>')

    close_ul()
    return "\n".join(buf)


# ── HTML page builder ──────────────────────────────────────────────────────────

CSS = """
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');

@page {
    size: letter;
    margin: 0.85in 0.9in 0.85in 0.9in;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
    font-family: 'Inter', 'Segoe UI', Arial, sans-serif;
    font-size: 10.5pt;
    color: #1a1a2e;
    line-height: 1.55;
    background: #ffffff;
}

/* ── Title bar ── */
.title-bar {
    background: #1E4374;
    color: #ffffff;
    padding: 10px 14px;
    border-radius: 4px;
    margin-bottom: 20px;
}
.title-bar .workflow { font-size: 13pt; font-weight: 700; }
.title-bar .meta     { font-size: 9pt; opacity: 0.8; margin-top: 2px; letter-spacing: 0.3px; }

/* ── Section headings ── */
.section-heading {
    font-size: 8.5pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #1E4374;
    border-bottom: 1.5px solid #1E4374;
    padding-bottom: 3px;
    margin-top: 22px;
    margin-bottom: 10px;
}

/* ── Physician dictation block ── */
.dictation-block {
    border-left: 4px solid #4472C4;
    padding: 6px 10px 6px 12px;
    margin: 6px 0 8px 0;
    background: #f5f7fb;
    border-radius: 0 3px 3px 0;
}
.dictation-block p {
    font-style: italic;
    color: #4a4a6a;
    font-size: 10.5pt;
    margin: 3px 0;
}

/* ── Generated note content ── */
.note-content h1 { font-size: 12pt; font-weight: 700; color: #1a1a2e; margin: 12px 0 5px 0; }
.note-content h2 { font-size: 11pt; font-weight: 700; color: #1E4374; margin: 10px 0 4px 0; }
.note-content h3 { font-size: 10.5pt; font-weight: 600; color: #2a4a7a; margin: 8px 0 3px 0; }
.note-content h4 { font-size: 10pt; font-weight: 600; color: #3a5a8a; margin: 6px 0 2px 0; }
.note-content p  { margin: 3px 0 5px 0; }
.note-content ul { margin: 3px 0 5px 16px; }
.note-content li { margin: 2px 0; }
.note-content .spacer { height: 6px; }

/* ── Footer ── */
.footer {
    margin-top: 28px;
    border-top: 1px solid #d0d8e8;
    padding-top: 6px;
    font-size: 8pt;
    color: #9aa3b4;
    text-align: right;
}
"""

def build_html(workflow, initials, dos, dictation, note_content):
    # Dictation segments split by ---
    dicts = [s.strip() for s in (dictation or "").split("\n---\n") if s.strip()]
    dict_html = "\n".join(
        f'<div class="dictation-block"><p>{html.escape(d)}</p></div>'
        for d in dicts
    ) or '<div class="dictation-block"><p><em>(no dictation captured)</em></p></div>'

    note_html = md_to_html(note_content)

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>{CSS}</style>
</head>
<body>

<div class="title-bar">
  <div class="workflow">{html.escape(workflow)}</div>
  <div class="meta">{html.escape(initials)} &nbsp;·&nbsp; {html.escape(dos)}</div>
</div>

<div class="section-heading">Physician Dictation</div>
{dict_html}

<div class="section-heading">Generated Note</div>
<div class="note-content">
{note_html}
</div>

<div class="footer">ChartGPT Notes &nbsp;·&nbsp; {html.escape(dos)}</div>

</body>
</html>"""


# ── Utilities ──────────────────────────────────────────────────────────────────

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

        filename     = f"{safe(workflow)}_{safe(initials)}.pdf"
        onedrive_dir = f"ChartGPT Notes/{year}/{month}/{date_dir}"
        pdf_path     = f"/tmp/{filename}"

        page_html = build_html(workflow, initials, dos, dictation, content)
        HTML(string=page_html).write_pdf(pdf_path)

        uploads.append(f"{pdf_path}|{onedrive_dir}")
        print(f"Created: {pdf_path} → {onedrive_dir}/{filename}")

    with open("/tmp/uploads.txt", "w") as f:
        f.write("\n".join(uploads))


if __name__ == "__main__":
    main()
