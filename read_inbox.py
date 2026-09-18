#!/usr/bin/env python3
"""
Reads inbox file(s) from the GitHub repo and writes /tmp/payload.json.

Single-file mode (default — used by repository_dispatch):
  Reads $INBOX_FILE, writes its content to /tmp/payload.json, deletes it.

All-files mode (--all — used by the nightly cron):
  Lists every file in inbox/, fetches and deletes each one, merges all
  conversation + notes payloads into a single /tmp/payload.json.
"""
import argparse
import base64
import json
import os
import urllib.request
import urllib.error

REPO = "yogeshs-lenity/ChartGPT-notes"
API  = f"https://api.github.com/repos/{REPO}/contents"

token = os.environ["GH_TOKEN"]

HEADERS = {
    "Authorization": f"Bearer {token}",
    "Accept":        "application/vnd.github+json",
}


def _get(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())


def _delete(url, sha, message):
    body = json.dumps({"message": message, "sha": sha}).encode()
    req  = urllib.request.Request(url, method="DELETE", data=body, headers={
        **HEADERS, "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req):
            pass
    except urllib.error.HTTPError as e:
        if e.code == 409:
            print(f"  Already deleted (409): {url.split('/')[-1]}")
        else:
            raise


def fetch_and_delete(path):
    """Fetch one inbox file, delete it from the repo, return parsed JSON or None if empty."""
    url  = f"{API}/{path}"
    data = _get(url)

    # GitHub Contents API returns content="" for files >1 MB; use download_url instead.
    encoded = (data.get("content") or "").replace("\n", "")
    if encoded:
        raw = base64.b64decode(encoded).decode("utf-8").strip()
    else:
        dl_url = data.get("download_url")
        if not dl_url:
            print(f"  Warning: {path} has no content and no download_url — skipping")
            _delete(url, data["sha"], f"Process: {path}")
            return None
        print(f"  File >1 MB — fetching via download_url")
        req = urllib.request.Request(dl_url, headers=HEADERS)
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode("utf-8").strip()

    _delete(url, data["sha"], f"Process: {path}")
    print(f"Fetched + deleted: {path}")
    if not raw:
        print(f"  Warning: {path} was empty — skipping")
        return None
    return json.loads(raw)


def single_mode():
    path = os.environ.get("INBOX_FILE", "").strip()
    if not path:
        raise SystemExit("INBOX_FILE env var is empty — no inbox file to read")
    payload = fetch_and_delete(path)
    if payload is None:
        print("Empty inbox file — nothing to process")
        with open("/tmp/payload.json", "w") as f:
            json.dump({}, f)
        return
    with open("/tmp/payload.json", "w") as f:
        json.dump(payload, f)
    print(f"Wrote /tmp/payload.json")


def all_mode():
    # List inbox/ directory
    try:
        files = _get(f"{API}/inbox")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print("inbox/ directory not found or empty — nothing to process")
            with open("/tmp/payload.json", "w") as f:
                json.dump({"conversations": []}, f)
            return
        raise

    json_files = [f for f in files if f.get("type") == "file" and f["name"].endswith(".json")]
    if not json_files:
        print("No inbox files found — nothing to process")
        with open("/tmp/payload.json", "w") as f:
            json.dump({"conversations": []}, f)
        return

    print(f"Found {len(json_files)} inbox file(s)")
    conversations = []
    combined_notes = []

    for f in json_files:
        content = fetch_and_delete(f["path"])
        if content is None:
            continue
        if "conversation" in content:
            conversations.append(content["conversation"])
        elif "conversations" in content:
            conversations.extend(content["conversations"])
        if "notes" in content:
            combined_notes.extend(content["notes"])

    payload = {}
    if conversations:
        payload["conversations"] = conversations
    if combined_notes:
        payload["notes"] = combined_notes
    if not payload:
        payload = {"conversations": []}

    with open("/tmp/payload.json", "w") as f:
        json.dump(payload, f)
    print(f"Merged {len(conversations)} conversation(s) + {len(combined_notes)} legacy note(s) → /tmp/payload.json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="Process all inbox files (cron mode)")
    args = ap.parse_args()

    if args.all:
        all_mode()
    else:
        single_mode()
