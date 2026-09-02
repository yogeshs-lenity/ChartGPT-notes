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


def markdown_to_docx(md):
    doc = Document()
    for line in md.split("\n"):
        if line.startswith("# "):
            doc.add_heading(line[2:].strip(), level=1)
        elif line.startswith("## "):
            doc.add_heading(line[3:].strip(), level=2)
        elif line.startswith("### "):
            doc.add_heading(line[4:].strip(), level=3)
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


def safe(text):
    return re.sub(r"[^\w\-]", "_", text).strip("_")


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
            f.write(markdown_to_docx(content))

        uploads.append(f"{docx_path}|{onedrive_dir}")
        print(f"Created: {docx_path} → {onedrive_dir}/{filename}")

    with open("/tmp/uploads.txt", "w") as f:
        f.write("\n".join(uploads))


if __name__ == "__main__":
    main()
