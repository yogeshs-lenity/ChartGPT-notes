#!/usr/bin/env python3
"""
backfill.py — one-time backfill of existing ChatGPT conversations.

Steps:
  1. Go to chatgpt.com → Settings → Data Controls → Export → Download the zip
  2. Unzip it — you'll find conversations.json inside
  3. Run:
       pip install playwright && playwright install chromium
       python backfill.py /path/to/conversations.json

Output lands in ./backfill_output/ organised as:
  ChartGPT Notes/YYYY/Month/MM-DD-YYYY/
  ├── ChartGPT_Notes_<date>_<id>.pdf      ← filtered clinical notes
  └── ChartGPT_Session_<date>_<id>.pdf   ← full conversation transcript

Copy that folder into your OneDrive to finish the backfill.
Already-created PDFs are skipped on re-runs (safe to re-run after errors).
"""

import argparse
import datetime
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
import chartgpt_notes as cn


def process_conversation(conv, out_root, today, stats):
    conv_id    = conv.get("conversation_id") or conv.get("id") or "conv"
    conv_title = (conv.get("title") or "").strip()
    msgs       = cn.messages_from_mapping(conv)
    if not msgs:
        stats["empty"] += 1
        return

    notes   = cn.split_notes(conv_id, msgs, today)
    session = (notes[0].get("date_of_service") if notes else None) or today
    dt      = cn.parse_session_date(session)

    folder = (out_root
              / "ChartGPT Notes"
              / dt.strftime("%Y")
              / dt.strftime("%B")
              / dt.strftime("%m-%d-%Y"))
    folder.mkdir(parents=True, exist_ok=True)
    saved_on   = dt.strftime("%B %d, %Y")
    title_slug = cn.safe(conv_title) if conv_title else f"{dt.strftime('%m-%d-%Y')}_{conv_id[:8]}"

    # Full session transcript — always
    sess_path = folder / f"{title_slug}_Session.pdf"
    if not sess_path.exists():
        cn.render_pdf(cn.build_full_conv_html(msgs, saved_on), str(sess_path))
        stats["transcripts"] += 1
        print(f"    transcript → {sess_path.relative_to(out_root)}")

    # Filtered notes PDF — only when clinical notes detected
    if notes:
        notes_path = folder / f"{title_slug}_Notes.pdf"
        if not notes_path.exists():
            cn.render_pdf(cn.build_combined_html(notes, saved_on), str(notes_path))
            stats["notes_pdfs"] += 1
            print(f"    notes PDF  → {notes_path.relative_to(out_root)}  ({len(notes)} notes)")
        stats["notes_count"] += len(notes)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="conversations.json from ChatGPT data export")
    ap.add_argument("--out", default="./backfill_output",
                    help="Output directory (default: ./backfill_output)")
    a = ap.parse_args()

    src = pathlib.Path(a.input)
    if not src.exists():
        sys.exit(f"Not found: {src}")

    out_root = pathlib.Path(a.out)
    out_root.mkdir(parents=True, exist_ok=True)

    data  = json.loads(src.read_text(encoding="utf-8"))
    convs = data if isinstance(data, list) else [data]
    today = datetime.date.today().strftime("%m/%d/%Y")

    stats = {"transcripts": 0, "notes_pdfs": 0, "notes_count": 0, "empty": 0, "errors": 0}
    print(f"Processing {len(convs)} conversations → {out_root}/\n")

    for i, conv in enumerate(convs, 1):
        title = (conv.get("title") or "(untitled)")[:60]
        print(f"[{i:>4}/{len(convs)}] {title}")
        try:
            process_conversation(conv, out_root, today, stats)
        except Exception as e:
            print(f"    ERROR: {e}")
            stats["errors"] += 1

    print(f"\nDone — {stats['transcripts']} transcripts, "
          f"{stats['notes_pdfs']} notes PDFs ({stats['notes_count']} clinical notes), "
          f"{stats['empty']} empty conversations skipped, "
          f"{stats['errors']} errors.")
    print(f"\nCopy '{out_root}/ChartGPT Notes' into your OneDrive to finish the backfill.")


if __name__ == "__main__":
    main()
