#!/usr/bin/env python3
"""Summarise one month of claude.ai visits from a Chromium browser's History file.

Optional helper: it needs Python 3, which many computers do not have. Reads only rows
whose URL starts with https://claude.ai/, on a temporary copy of the History file that
is deleted afterwards. Prints one JSON object.

    python chrome_history.py --month 2026-11 [--browser chrome|edge|brave] [--profile Default]
"""
import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timedelta

EPOCH_DELTA_S = 11644473600  # Chrome time is microseconds since 1601-01-01
VISIT_CAP_MIN = 60  # a tab left open must not count as hours of use
HOST = "https://claude.ai/"


def user_data_dir(browser):
    home = os.path.expanduser("~")
    local = os.environ.get("LOCALAPPDATA", "")
    paths = {
        "chrome": [os.path.join(local, "Google", "Chrome", "User Data"),
                   os.path.join(home, "Library", "Application Support", "Google", "Chrome"),
                   os.path.join(home, ".config", "google-chrome")],
        "edge": [os.path.join(local, "Microsoft", "Edge", "User Data"),
                 os.path.join(home, "Library", "Application Support", "Microsoft Edge"),
                 os.path.join(home, ".config", "microsoft-edge")],
        "brave": [os.path.join(local, "BraveSoftware", "Brave-Browser", "User Data"),
                  os.path.join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
                  os.path.join(home, ".config", "BraveSoftware", "Brave-Browser")],
    }[browser]
    for p in paths:
        if p and os.path.isdir(p):
            return p
    return None


def month_bounds(month):
    start = datetime.strptime(month, "%Y-%m")
    end = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    to_chrome = lambda d: int((d.timestamp() + EPOCH_DELTA_S) * 1_000_000)
    return to_chrome(start), to_chrome(end)


def profiles(root, only):
    if only:
        return [only]
    names = [n for n in os.listdir(root) if n == "Default" or re.fullmatch(r"Profile \d+", n)]
    return [n for n in names if os.path.isfile(os.path.join(root, n, "History"))]


def read_rows(history_path, lo, hi):
    tmp = tempfile.mkdtemp(prefix="hist-")
    try:
        for suffix in ("", "-wal", "-shm"):
            src = history_path + suffix
            if os.path.isfile(src):
                shutil.copy2(src, os.path.join(tmp, "History" + suffix))
        con = sqlite3.connect(os.path.join(tmp, "History"))
        try:
            return con.execute(
                "SELECT u.url, u.title, v.visit_time, v.visit_duration FROM visits v "
                "JOIN urls u ON u.id = v.url "
                "WHERE u.url LIKE ? AND v.visit_time >= ? AND v.visit_time < ?",
                (HOST + "%", lo, hi)).fetchall()
        finally:
            con.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def kind_of(url):
    path = url[len(HOST):].split("?")[0].split("#")[0].strip("/")
    if re.match(r"chat/[0-9a-f-]{8,}", path):
        return "chat", path.split("/")[1]
    if re.match(r"project/[0-9a-f-]{8,}", path):
        return "project", path.split("/")[1]
    if path.startswith("code"):
        return "code", path
    if path.startswith("settings/usage"):
        return "usage", path
    if path.startswith("artifact"):
        return "artifacts", path
    if re.match(r"(login|logout|join|magic-link|oauth|redirect|onboarding|api|desktop)\b", path):
        return "auth", path
    if path in ("", "new"):
        return "new", path
    return "other", path


def clean_title(t):
    t = re.sub(r"\s*[-–|]\s*Claude\s*$", "", t or "").strip()
    return "" if t in ("", "Claude", "New chat") else t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", required=True)
    ap.add_argument("--browser", default="chrome", choices=["chrome", "edge", "brave"])
    ap.add_argument("--profile", default="")
    a = ap.parse_args()

    root = user_data_dir(a.browser)
    if not root:
        sys.exit(json.dumps({"error": f"{a.browser} user data folder not found"}))
    lo, hi = month_bounds(a.month)

    rows, used, failed = [], [], []
    for p in profiles(root, a.profile):
        try:
            rows += read_rows(os.path.join(root, p, "History"), lo, hi)
            used.append(p)
        except (OSError, sqlite3.Error) as e:
            failed.append(f"{p}: {e}")

    days = defaultdict(lambda: {"visits": 0, "minutes": 0.0, "chats": set()})
    chats, projects, other = {}, {}, Counter()
    for url, title, vt, dur in rows:
        when = datetime.fromtimestamp(vt / 1_000_000 - EPOCH_DELTA_S)
        day = when.strftime("%Y-%m-%d")
        mins = min((dur or 0) / 60_000_000, VISIT_CAP_MIN)
        kind, ident = kind_of(url)
        if kind == "auth":  # sign-in noise is not use; its URLs can carry tokens and are never printed
            continue
        d = days[day]
        d["visits"] += 1
        d["minutes"] += mins
        if kind in ("chat", "project"):
            store = chats if kind == "chat" else projects
            c = store.setdefault(ident, {"titles": Counter(), "days": set(), "visits": 0, "minutes": 0.0})
            c["titles"][clean_title(title)] += 1
            c["days"].add(day)
            c["visits"] += 1
            c["minutes"] += mins
            if kind == "chat":
                d["chats"].add(ident)
        else:
            other[kind] += 1

    def best(counter):
        return next((t for t, _ in counter.most_common() if t), "")

    def rank(store, with_range):
        out = []
        for c in store.values():
            row = {"title": best(c["titles"]), "activeDays": len(c["days"]), "visits": c["visits"], "minutes": round(c["minutes"])}
            if with_range:
                row = {"title": row["title"], "firstDay": min(c["days"]), "lastDay": max(c["days"]), **{k: row[k] for k in ("activeDays", "visits", "minutes")}}
            out.append(row)
        return sorted(out, key=lambda r: (-r["minutes"], -r["visits"]))

    print(json.dumps({
        "month": a.month, "browser": a.browser, "profiles": used, "failed": failed,
        "visitMinuteCap": VISIT_CAP_MIN, "totalVisits": sum(v["visits"] for v in days.values()),
        "days": [{"date": k, "visits": v["visits"], "minutes": round(v["minutes"]), "chats": len(v["chats"])}
                 for k, v in sorted(days.items())],
        "chats": rank(chats, True), "projects": rank(projects, False), "otherVisits": dict(other),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
