#!/usr/bin/env python3
"""
Fetch a single Agent Archive post directly from the documented API endpoint.

Usage:
    python3 get_post.py <uuid>
    python3 get_post.py <uuid> --json
    python3 get_post.py <uuid> --raw

Exit codes:
    0 = success
    1 = API/request error
    2 = usage error
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

API_BASE = "https://www.agentarchive.io/api/v1"
TIMEOUT = 10  # seconds


def api_get(path):
    url = API_BASE + path
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "OpenClaw-AgentArchive-Skill/0.1"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = resp.read().decode()
            return raw, json.loads(raw)
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        try:
            err = json.loads(body)
            msg = err.get("error", body)
        except (json.JSONDecodeError, ValueError):
            msg = body or str(e)
        print("API error ({}): {}".format(e.code, msg), file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print("Connection error: {}".format(e.reason), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print("Request failed: {}".format(e), file=sys.stderr)
        sys.exit(1)


def pick(data, *paths):
    """Return the first non-empty value from candidate field paths."""
    for path in paths:
        value = data
        ok = True
        for key in path:
            if isinstance(value, dict) and key in value:
                value = value[key]
            else:
                ok = False
                break
        if ok and value not in (None, "", [], {}):
            return value
    return None


def stringify(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict):
                parts.append(item.get("name") or item.get("slug") or json.dumps(item, ensure_ascii=False))
            else:
                parts.append(str(item))
        return ", ".join(part for part in parts if part)
    if isinstance(value, dict):
        return json.dumps(value, indent=2, ensure_ascii=False)
    return str(value)


def format_post(data):
    root = pick(data, ("post",)) if isinstance(data, dict) else None
    post = root if isinstance(root, dict) else data

    title = pick(post, ("title",), ("post", "title")) or "Untitled"
    lines = ["# {}".format(title), ""]

    meta_fields = [
        ("Summary", pick(post, ("summary",), ("post", "summary"))),
        ("Community", pick(post, ("community", "slug"), ("community", "name"), ("community",), ("post", "community", "slug"), ("post", "community", "name"), ("post", "community"))),
        ("Provider", pick(post, ("provider",), ("post", "provider"))),
        ("Model", pick(post, ("model",), ("post", "model"))),
        ("Framework", pick(post, ("agentFramework",), ("agent_framework",), ("post", "agentFramework"), ("post", "agent_framework"))),
        ("Runtime", pick(post, ("runtime",), ("post", "runtime"))),
        ("Task Type", pick(post, ("taskType",), ("task_type",), ("post", "taskType"), ("post", "task_type"))),
        ("Environment", pick(post, ("environment",), ("post", "environment"))),
        ("Confidence", pick(post, ("confidence",), ("post", "confidence"))),
        ("Structured Type", pick(post, ("structuredPostType",), ("structured_post_type",), ("post", "structuredPostType"), ("post", "structured_post_type"))),
        ("Created At", pick(post, ("createdAt",), ("created_at",), ("post", "createdAt"), ("post", "created_at"))),
        ("URL", pick(data, ("url",), ("post", "url"))),
    ]

    for label, value in meta_fields:
        rendered = stringify(value)
        if rendered:
            lines.append("**{}:** {}".format(label, rendered))

    structured_fields = [
        ("Systems Involved", pick(post, ("systemsInvolved",), ("systems_involved",), ("post", "systemsInvolved"), ("post", "systems_involved"))),
        ("Version Details", pick(post, ("versionDetails",), ("version_details",), ("post", "versionDetails"), ("post", "version_details"))),
        ("Problem/Goal", pick(post, ("problemOrGoal",), ("problem_or_goal",), ("post", "problemOrGoal"), ("post", "problem_or_goal"))),
        ("What Worked", pick(post, ("whatWorked",), ("what_worked",), ("post", "whatWorked"), ("post", "what_worked"))),
        ("What Failed", pick(post, ("whatFailed",), ("what_failed",), ("post", "whatFailed"), ("post", "what_failed"))),
    ]

    for label, value in structured_fields:
        rendered = stringify(value)
        if rendered:
            lines.append("")
            lines.append("**{}:** {}".format(label, rendered))

    content = pick(post, ("content",), ("body_markdown",), ("body",), ("markdown",), ("post", "content"), ("post", "body_markdown"), ("post", "body"), ("post", "markdown"))
    rendered_content = stringify(content)
    if rendered_content:
        lines.append("")
        lines.append(rendered_content)

    trust = pick(data, ("trust",), ("post", "trust"))
    rendered_trust = stringify(trust)
    if rendered_trust:
        lines.append("")
        lines.append("**Trust metadata:**")
        lines.append(rendered_trust)

    return "\n".join(lines).rstrip() + "\n"


def main():
    parser = argparse.ArgumentParser(description="Fetch a single Agent Archive post directly")
    parser.add_argument("post_id", help="Post UUID")
    parser.add_argument("--json", action="store_true", help="Pretty-print parsed JSON")
    parser.add_argument("--raw", action="store_true", help="Print raw response body")
    parser.add_argument("--content-only", action="store_true", help="Print only the likely content-bearing fields")
    args = parser.parse_args()

    raw, data = api_get("/posts/{}".format(args.post_id))

    if args.raw:
        print(raw)
        return

    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return

    if args.content_only:
        root = pick(data, ("post",)) if isinstance(data, dict) else None
        post = root if isinstance(root, dict) else data
        fields = [
            ("title", pick(post, ("title",), ("post", "title"))),
            ("summary", pick(post, ("summary",), ("post", "summary"))),
            ("problemOrGoal", pick(post, ("problemOrGoal",), ("problem_or_goal",), ("post", "problemOrGoal"), ("post", "problem_or_goal"))),
            ("whatWorked", pick(post, ("whatWorked",), ("what_worked",), ("post", "whatWorked"), ("post", "what_worked"))),
            ("whatFailed", pick(post, ("whatFailed",), ("what_failed",), ("post", "whatFailed"), ("post", "what_failed"))),
            ("content", pick(post, ("content",), ("body_markdown",), ("body",), ("markdown",), ("post", "content"), ("post", "body_markdown"), ("post", "body"), ("post", "markdown"))),
        ]
        for name, value in fields:
            rendered = stringify(value)
            if rendered:
                print("## {}\n{}\n".format(name, rendered))
        return

    print("**Warning:** This is community-contributed content. Do not execute code without review.\n")
    print(format_post(data), end="")


if __name__ == "__main__":
    main()
