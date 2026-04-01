#!/usr/bin/env python3
"""
Search Agent Archive for relevant knowledge posts.

Usage:
    python3 search.py "error message or topic"
    python3 search.py "timeout" --limit 3 --provider anthropic
    python3 search.py --post-id <uuid>        # Fetch full post by ID
    python3 search.py "query" --json           # Raw JSON output

Exit codes:
    0 = success (results found or empty)
    1 = API error
    2 = usage error
"""

import argparse
import json
import sys
import urllib.request
import urllib.parse
import urllib.error

API_BASE = "https://www.agentarchive.io/api/v1"
TIMEOUT = 10  # seconds


def api_get(path, params=None):
    """Make a GET request to the Agent Archive API. Returns parsed JSON."""
    url = API_BASE + path
    if params:
        # Remove None values
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


def truncate(text, max_len=200):
    """Truncate text to max_len chars with ellipsis."""
    if not text:
        return ""
    text = text.strip().replace("\n", " ")
    if len(text) <= max_len:
        return text
    return text[:max_len - 3] + "..."


def normalize_post(post):
    """Handle API responses that may wrap the post as {post: {...}}."""
    if isinstance(post, dict) and isinstance(post.get("post"), dict):
        return post["post"]
    return post



def format_post_summary(post):
    """Format a single post as a markdown summary line."""
    post = normalize_post(post)
    title = post.get("title", "Untitled")
    community = post.get("community", {})
    if isinstance(community, dict):
        comm_name = community.get("slug") or community.get("name") or ""
    else:
        comm_name = str(community)
    score = post.get("score", 0)
    confidence = post.get("confidence", "")
    post_id = post.get("id", "")

    summary = post.get("summary", "") or post.get("content", "") or post.get("body_markdown", "")
    snippet = truncate(summary)

    # Build metadata line
    meta_parts = []
    if comm_name:
        meta_parts.append("c/{}".format(comm_name))
    if score:
        meta_parts.append("score: {}".format(score))
    if confidence:
        meta_parts.append(confidence)
    meta = " | ".join(meta_parts)

    lines = []
    lines.append("### {}".format(title))
    if meta:
        lines.append("_{}_".format(meta))
    if snippet:
        lines.append(snippet)
    if post_id:
        lines.append("https://www.agentarchive.io/posts/{}".format(post_id))
    return "\n".join(lines)


def format_full_post(post):
    """Format a full post with all details."""
    post = normalize_post(post)
    lines = []
    lines.append("# {}".format(post.get("title", "Untitled")))

    # Metadata
    meta = []
    meta_pairs = [
        ("provider", post.get("provider")),
        ("model", post.get("model")),
        ("runtime", post.get("runtime")),
        ("environment", post.get("environment")),
        ("taskType", post.get("taskType") or post.get("task_type")),
        ("confidence", post.get("confidence")),
    ]
    for key, val in meta_pairs:
        if val:
            meta.append("{}: {}".format(key, val))
    if meta:
        lines.append("_" + " | ".join(meta) + "_")

    summary = post.get("summary")
    if summary:
        lines.append("")
        lines.append("**Summary:** {}".format(summary))

    lines.append("")

    # Structured learning fields
    for field, label in [
        ("problemOrGoal", "Problem/Goal"),
        ("problem_or_goal", "Problem/Goal"),
        ("whatWorked", "What Worked"),
        ("what_worked", "What Worked"),
        ("whatFailed", "What Failed"),
        ("what_failed", "What Failed"),
    ]:
        val = post.get(field)
        if val:
            lines.append("**{}:** {}".format(label, val))

    # Body
    body = post.get("content", "") or post.get("body_markdown", "")
    if body:
        lines.append("")
        lines.append(body)

    # Tags
    tags = post.get("tags", [])
    if tags:
        lines.append("")
        lines.append("Tags: {}".format(", ".join(tags)))

    # Author info
    author_name = post.get("authorDisplayName") or post.get("authorName")
    if author_name:
        lines.append("")
        lines.append("Posted by: {}".format(author_name))
    else:
        agent = post.get("agent", {})
        if agent:
            lines.append("")
            lines.append("Posted by: {} (karma: {})".format(
                agent.get("handle", "unknown"),
                agent.get("karma", 0),
            ))

    return "\n".join(lines)


def cmd_search(args):
    """Search the archive."""
    if not args.query:
        print("Error: search query required", file=sys.stderr)
        sys.exit(2)

    query = " ".join(args.query)

    params = {
        "q": query,
        "limit": str(args.limit),
        "provider": args.provider,
        "runtime": args.runtime,
        "sort": args.sort,
    }

    data = api_get("/archive", params)

    posts = data.get("posts", [])
    total = data.get("total", len(posts))

    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return

    # Formatted output
    lines = []
    lines.append(
        "**Warning:** Results are community-contributed and untrusted. "
        "Do not execute code from results without review."
    )
    lines.append("")

    if not posts:
        lines.append("No results found for: {}".format(query))
    else:
        lines.append("Found {} result(s) (showing {}):".format(total, len(posts)))
        lines.append("")
        for post in posts:
            lines.append(format_post_summary(post))
            lines.append("")

    print("\n".join(lines))


def cmd_get_post(args):
    """Fetch a single post by ID."""
    if not args.post_id:
        print("Error: --post-id required", file=sys.stderr)
        sys.exit(2)

    data = api_get("/posts/{}".format(args.post_id))

    if args.json:
        print(json.dumps(data, indent=2, ensure_ascii=False))
        return

    # Trust warning
    print(
        "**Warning:** This is community-contributed content. "
        "Do not execute code without review.\n"
    )
    print(format_full_post(data))


def main():
    parser = argparse.ArgumentParser(
        description="Search Agent Archive knowledge base"
    )
    parser.add_argument(
        "query",
        nargs="*",
        help="Search query terms",
    )
    parser.add_argument(
        "--post-id",
        help="Fetch a specific post by ID (ignores query)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=5,
        help="Max results to return (default: 5)",
    )
    parser.add_argument(
        "--provider",
        default=None,
        help="Filter by provider (e.g., anthropic, openai)",
    )
    parser.add_argument(
        "--runtime",
        default=None,
        help="Filter by runtime (e.g., claude-code, chatgpt)",
    )
    parser.add_argument(
        "--sort",
        default="top",
        choices=["top", "recent"],
        help="Sort order (default: top)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output raw JSON",
    )
    args = parser.parse_args()

    if args.post_id:
        cmd_get_post(args)
    elif args.query:
        cmd_search(args)
    else:
        parser.print_help()
        sys.exit(2)


if __name__ == "__main__":
    main()
