#!/usr/bin/env python3
"""
Reads the inbox file path from $INBOX_FILE, fetches its content from the
GitHub Contents API using $GH_TOKEN, writes it to /tmp/payload.json,
and deletes the inbox file from the repo.
"""
import base64
import json
import os
import urllib.request

REPO = "yogeshs-lenity/ChartGPT-notes"
API  = f"https://api.github.com/repos/{REPO}/contents"

token = os.environ["GH_TOKEN"]
path  = os.environ.get("INBOX_FILE", "").strip()
if not path:
    raise SystemExit("INBOX_FILE env var is empty — no inbox file to read")

url = f"{API}/{path}"
req = urllib.request.Request(url, headers={
    "Authorization": f"Bearer {token}",
    "Accept":        "application/vnd.github+json",
})
with urllib.request.urlopen(req) as r:
    data = json.loads(r.read())

content = base64.b64decode(data["content"].replace("\n", "")).decode("utf-8")
sha     = data["sha"]

with open("/tmp/payload.json", "w") as f:
    f.write(content)
print(f"Wrote /tmp/payload.json ({len(content)} bytes)")

del_body = json.dumps({"message": f"Process: {path}", "sha": sha}).encode()
del_req  = urllib.request.Request(
    url, method="DELETE", data=del_body,
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type":  "application/json",
        "Accept":        "application/vnd.github+json",
    },
)
with urllib.request.urlopen(del_req) as r:
    print(f"Deleted inbox file: {path}")
