import io
import json
import os
import re
import sys
from datetime import datetime

from docx import Document


def add_inline(para, text):
    for part in re.split(r"(\*\*[^*]+\*\*)", text):
        if part.startswith("**") and part.endswith("**"):
            para.add_run(part[2:-2]).bold = True
        elif part:
            para.add_run(part)


def safe(text):
    return re.sub(r"[^\w\-]", "_", text).strip("_")


def build_docx(workflow, initials, dictation, note_content):
    doc = Document()

    # --- Physician Dictation section ---
    doc.add_heading("Physician Dictation", level=1)
    for segment in (dictation or "").split("\n---\n"):
        segment = segment.strip()
        if segment:
            doc.add_paragraph(segment)
        doc.add_paragraph()

    doc.add_paragraph("─" * 60)

    # --- Generated Note section ---
    doc.add_heading("Generated Note", level=1)
    for line in note_content.split("\n"):
        if line.startswith("# "):
            doc.add_heading(line[2:].strip(), level=2)
        elif line.startswith("## "):
            doc.add_heading(line[3:].strip(), level=3)
        elif line.startswith("### "):
            doc.add_heading(line[4:].strip(), level=4)
        elif line.startswith("- "):
            add_inline(doc.add_paragraph(style="List Bullet"), line[2:].strip())
        elif re.match(r"^\d+\. ", line):
            add_inline(doc.add_paragraph(style="List Number"),
                       re.sub(r"^\d+\.\s*", "", line))
        elif not line.strip():
            doc.add_paragraph()
        else:
            add_inline(doc.add_paragraph(), line)

    buf = io.BytesIO()
    doc.save(buf)
    buf.seek(0)
    return buf.read()


def main():
    data = json.loads(sys.stdin.read())

    # Support both single note and end-of-day batch
    if "notes" in data:
        notes = data["notes"]
    else:
        notes = [data]

    uploads = []

    for note in notes:
        workflow     = note["workflow_type"]
        initials     = note["patient_initials"]
        dictation    = note.get("dictation", "")
        content      = note["note_content"]
        session      = note.get("session_date", data.get("session_date"))

        dt           = datetime.strptime(session, "%m/%d/%Y")
        year         = dt.strftime("%Y")
        month        = dt.strftime("%B")
        date_dir     = dt.strftime("%m-%d-%Y")

        filename     = f"{safe(workflow)}_{safe(initials)}.docx"
        onedrive_dir = f"ChartGPT Notes/{year}/{month}/{date_dir}"
        docx_path    = f"/tmp/{filename}"

        with open(docx_path, "wb") as f:
            f.write(build_docx(workflow, initials, dictation, content))

        uploads.append(f"{docx_path}|{onedrive_dir}")
        print(f"Created: {docx_path} → {onedrive_dir}/{filename}")

    with open("/tmp/uploads.txt", "w") as f:
        f.write("\n".join(uploads))


if __name__ == "__main__":
    main()
