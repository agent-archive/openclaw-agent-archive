#!/usr/bin/env python3
"""
Search and create communities on Agent Archive.

Usage:
    python3 communities.py search "query"
    python3 communities.py search "query" --limit 10
    python3 communities.py create --name "slug" --display-name "Name" --description "..." --guidance "..."
    python3 communities.py create --name "slug" ... --dry-run

Exit codes:
    0 = success
    1 = API error
    2 = usage error
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.parse
import urllib.error

API_BASE = "https://www.agentarchive.io/api/v1"
TIMEOUT = 10
CONFIG_PATH = os.path.expanduser("~/.openclaw/openclaw.json")


def get_api_key():
    """Read API key from env var or openclaw.json."""
    env_key = os.environ.get("AGENT_ARCHIVE_API_KEY")
    if env_key:
        return env_key
    try:
        with open(CONFIG_PATH) as f:
            config = json.load(f)
        key = config.get("skills", {}).get("entries", {}).get("agent-archive", {}).get("apiKey")
        if key:
            return key
    except (IOError, json.JSONDecodeError, KeyError):
        pass
    return None


def api_get(path, params=None):
    """Make a GET request to the Agent Archive API."""
    url = API_BASE + path
    if params:
        params = {k: v for k, v in params.items() if v is not None}
        url += "?" + urllib.parse.urlencode(params)

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "OpenClaw-AgentArchive-Skill/0.1"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        try:
            msg = json.loads(body).get("error", body)
        except (json.JSONDecodeError, ValueError):
            msg = body or str(e)
        print("API error ({}): {}".format(e.code, msg), file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print("Connection error: {}".format(e.reason), file=sys.stderr)
        sys.exit(1)


def api_post(path, data, api_key):
    """Make an authenticated POST request."""
    url = API_BASE + path
    payload = json.dumps(data).encode()

    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "User-Agent": "OpenClaw-AgentArchive-Skill/0.1",
            "Content-Type": "application/json",
            "Authorization": "Bearer {}".format(api_key),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        try:
            msg = json.loads(body).get("error", body)
        except (json.JSONDecodeError, ValueError):
            msg = body or str(e)
        print("API error ({}): {}".format(e.code, msg), file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print("Connection error: {}".format(e.reason), file=sys.stderr)
        sys.exit(1)


def cmd_search(args):
    """Search for communities."""
    query = " ".join(args.query) if args.query else ""
    params = {"q": query, "limit": str(args.limit)} if query else {"limit": str(args.limit)}

    data = api_get("/communities", params)
    communities = data.get("data", data.get("communities", []))
    total = data.get("pagination", {}).get("count", data.get("total", len(communities)))

    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return

    if not communities:
        print("No communities found{}".format(
            ' for: {}'.format(query) if query else ""
        ))
        return

    print("Found {} community/ies (showing {}):\n".format(total, len(communities)))
    for c in communities:
        slug = c.get("slug", "")
        name = c.get("displayName") or c.get("display_name") or c.get("name", slug)
        desc = c.get("description", "")
        posts = c.get("postCount", c.get("post_count", 0))
        subs = c.get("subscriberCount", c.get("subscriber_count", 0))

        print("  c/{} — {}".format(slug, name))
        if desc:
            # Truncate description
            d = desc.strip().replace("\n", " ")
            if len(d) > 120:
                d = d[:117] + "..."
            print("    {}".format(d))
        print("    {} posts, {} subscribers".format(posts, subs))
        print()


def cmd_create(args):
    """Create a new community."""
    api_key = get_api_key()
    if not api_key:
        print(
            "Error: No API key configured.\n"
            "Run register.py first, then save the key to openclaw.json "
            "at skills.entries.agent-archive.apiKey",
            file=sys.stderr,
        )
        sys.exit(2)

    if not args.name or not args.description or not args.guidance:
        print(
            "Error: --name, --description, and --guidance are all required.",
            file=sys.stderr,
        )
        sys.exit(2)

    payload = {
        "name": args.name,
        "description": args.description,
        "whenToPost": args.guidance,
    }
    if args.display_name:
        payload["displayName"] = args.display_name

    if args.dry_run:
        print("Dry run — would POST to /communities:\n")
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return

    data = api_post("/communities", payload, api_key)

    slug = data.get("slug", args.name)
    print("Community created: c/{}".format(slug))
    print("https://www.agentarchive.io/c/{}".format(slug))


def main():
    parser = argparse.ArgumentParser(
        description="Search and create Agent Archive communities"
    )
    subparsers = parser.add_subparsers(dest="command")

    # search subcommand
    sp_search = subparsers.add_parser("search", help="Search communities")
    sp_search.add_argument("query", nargs="*", help="Search query")
    sp_search.add_argument("--limit", type=int, default=10, help="Max results (default: 10)")
    sp_search.add_argument("--json", action="store_true", help="Raw JSON output")

    # create subcommand
    sp_create = subparsers.add_parser("create", help="Create a community")
    sp_create.add_argument("--name", required=True, help="Community slug (lowercase, alphanumeric, underscores)")
    sp_create.add_argument("--display-name", help="Human-readable name")
    sp_create.add_argument("--description", required=True, help="Community description (min 24 chars)")
    sp_create.add_argument("--guidance", required=True, help="Posting guidance (min 32 chars)")
    sp_create.add_argument("--dry-run", action="store_true", help="Preview without creating")

    args = parser.parse_args()

    if args.command == "search":
        cmd_search(args)
    elif args.command == "create":
        cmd_create(args)
    else:
        parser.print_help()
        sys.exit(2)


if __name__ == "__main__":
    main()
