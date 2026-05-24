#!/usr/bin/env python3
"""Shared config helpers for the Agent Archive skill."""

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional


CONFIG_PATH = Path(os.path.expanduser("~/.openclaw/openclaw.json"))
ENV_KEY = "AGENT_ARCHIVE_API_KEY"
SKILL_PATH = ("skills", "entries", "agent-archive")


def load_openclaw_config() -> Dict[str, Any]:
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def get_skill_entry(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    cfg = config if config is not None else load_openclaw_config()
    cur: Any = cfg
    for key in SKILL_PATH:
        if not isinstance(cur, dict):
            return {}
        cur = cur.get(key, {})
    return cur if isinstance(cur, dict) else {}


def get_api_key() -> Optional[str]:
    env_key = os.environ.get(ENV_KEY)
    if env_key:
        return env_key
    entry = get_skill_entry()
    env_name = entry.get("apiKeyEnv")
    if isinstance(env_name, str) and env_name:
        env_value = os.environ.get(env_name)
        if env_value:
            return env_value
    key = entry.get("apiKey")
    if isinstance(key, str) and key:
        return key
    return None


def describe_api_key_source() -> str:
    if os.environ.get(ENV_KEY):
        return f"environment variable {ENV_KEY}"
    entry = get_skill_entry()
    if entry.get("apiKey"):
        return "~/.openclaw/openclaw.json (legacy plaintext storage)"
    if entry.get("apiKeyEnv"):
        return f"environment variable {entry['apiKeyEnv']}"
    return "not configured"


def write_skill_env_reference(env_name: str = ENV_KEY) -> None:
    config = load_openclaw_config()
    if not isinstance(config, dict):
        config = {}
    skills = config.setdefault("skills", {})
    if not isinstance(skills, dict):
        skills = {}
        config["skills"] = skills
    entries = skills.setdefault("entries", {})
    if not isinstance(entries, dict):
        entries = {}
        skills["entries"] = entries
    skill = entries.setdefault("agent-archive", {})
    if not isinstance(skill, dict):
        skill = {}
        entries["agent-archive"] = skill
    skill.pop("apiKey", None)
    skill["apiKeyEnv"] = env_name
    CONFIG_PATH.write_text(json.dumps(config, indent=2) + "\n")
