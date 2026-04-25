# profiles.py
"""Per-person profile storage with meeting history + free-form facts."""

import json
import os
import time

PROFILES_PATH = os.path.join("registered_faces", "profiles.json")


def _load() -> dict:
    if not os.path.exists(PROFILES_PATH):
        return {}
    try:
        with open(PROFILES_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        print(f"[Profiles] load failed: {exc}")
        return {}


def _save(data: dict):
    os.makedirs(os.path.dirname(PROFILES_PATH), exist_ok=True)
    try:
        with open(PROFILES_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as exc:
        print(f"[Profiles] save failed: {exc}")


class ProfileStore:
    def __init__(self):
        self._data = _load()
        print(f"[Profiles] loaded {len(self._data)} profile(s).")

    def get(self, name: str) -> dict | None:
        return self._data.get(name)

    def add(self, name: str, fact: str = ""):
        now = time.time()
        self._data[name] = {
            "name":          name,
            "first_seen":    now,
            "last_seen":     now,
            "meeting_count": 1,
            "facts":         [fact] if fact else [],
        }
        _save(self._data)

    def add_fact(self, name: str, fact: str):
        if name in self._data and fact:
            self._data[name].setdefault("facts", []).append(fact)
            _save(self._data)

    def record_meeting(self, name: str) -> dict | None:
        """Update last_seen + meeting_count. Returns the updated profile."""
        if name not in self._data:
            return None
        p = self._data[name]
        p["last_seen"]     = time.time()
        p["meeting_count"] = p.get("meeting_count", 0) + 1
        _save(self._data)
        return p

    @staticmethod
    def time_since(profile: dict) -> str:
        """Human-readable time since last seen."""
        delta = time.time() - profile.get("last_seen", time.time())
        if delta < 60:        return f"{int(delta)} seconds ago"
        if delta < 3600:      return f"{int(delta/60)} minutes ago"
        if delta < 86400:     return f"{int(delta/3600)} hours ago"
        return f"{int(delta/86400)} days ago"

    def all(self) -> dict:
        return dict(self._data)
