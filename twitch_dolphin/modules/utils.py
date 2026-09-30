import json
from pathlib import Path
from typing import Any


def load_json(path: str | Path) -> dict[str, Any]:
    file_path = Path(path)
    if not file_path.exists():
        return {}
    with file_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: str | Path, data: dict[str, Any]) -> None:
    file_path = Path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    with file_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)
        f.write("\n")


def load_config(path: str | Path = "config.json") -> dict[str, Any]:
    return load_json(path)


def load_profiles(path: str | Path) -> list[str]:
    file_path = Path(path)
    if not file_path.exists():
        return []
    profiles: list[str] = []
    with file_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            profiles.append(line.split()[0])
    return profiles


def load_accounts(path: str | Path) -> dict[str, dict[str, str]]:
    """
    Parse accounts.txt into accounts[profile_id] = {"login": ..., "password": ...}.
    """
    file_path = Path(path)
    accounts: dict[str, dict[str, str]] = {}
    if not file_path.exists():
        return accounts

    with file_path.open("r", encoding="utf-8") as f:
        for line_no, raw in enumerate(f, start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("|")
            if len(parts) < 3:
                raise ValueError(
                    f"Invalid accounts.txt line {line_no}: expected PROFILE_ID|LOGIN|PASSWORD"
                )
            profile_id = parts[0].strip()
            login = parts[1].strip()
            password = "|".join(parts[2:]).strip()
            if not profile_id:
                continue
            accounts[profile_id] = {"login": login, "password": password}
    return accounts


def ensure_progress_entry(progress: dict[str, Any], profile_id: str) -> dict[str, Any]:
    if profile_id not in progress:
        progress[profile_id] = {
            "login": "not_started",
            "jumble": "not_started",
            "completed": False,
        }
    return progress[profile_id]
