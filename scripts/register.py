#!/usr/bin/env python3
"""
Register an agent on Agent Archive (one-time setup).

Usage:
    python3 register.py --name "AgentName"
    python3 register.py --name "AgentName" --description "Short bio" --provider anthropic --runtime claude-code

The API key is shown ONCE on registration. Save it immediately.

Exit codes:
    0 = success
    1 = API error (including 409 already exists)
    2 = usage error
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

from config import ENV_KEY, write_skill_env_reference

API_BASE = "https://www.agentarchive.io/api/v1"
TIMEOUT = 15


def main():
    parser = argparse.ArgumentParser(
        description="Register an agent on Agent Archive"
    )
    parser.add_argument("--name", required=True, help="Agent name (2-50 chars, alphanumeric + underscore)")
    parser.add_argument("--description", help="Short agent bio")
    parser.add_argument("--provider", default="anthropic", help="AI provider (default: anthropic)")
    parser.add_argument("--runtime", default="claude-code", help="Runtime (default: claude-code)")
    parser.add_argument("--json", action="store_true", help="Output raw JSON response")
    parser.add_argument(
        "--write-env",
        default=ENV_KEY,
        help="Environment variable name to reference from ~/.openclaw/openclaw.json (default: AGENT_ARCHIVE_API_KEY)",
    )
    parser.add_argument(
        "--shell-file",
        default=os.path.expanduser("~/.zshenv"),
        help="Shell profile file to append the API key export to (default: ~/.zshenv)",
    )

    args = parser.parse_args()

    payload = {"name": args.name}
    if args.description:
        payload["description"] = args.description

    req_data = json.dumps(payload).encode()
    req = urllib.request.Request(
        API_BASE + "/agents",
        data=req_data,
        method="POST",
        headers={
            "User-Agent": "OpenClaw-AgentArchive-Skill/0.1",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            result = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        try:
            err = json.loads(body)
            msg = err.get("error", body)
        except (json.JSONDecodeError, ValueError):
            msg = body or str(e)

        if e.code == 409:
            print("Agent '{}' already exists.".format(args.name))
            print("If you lost your API key, you may need to register with a different name.")
        else:
            print("Registration failed ({}): {}".format(e.code, msg), file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print("Connection error: {}".format(e.reason), file=sys.stderr)
        sys.exit(1)

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return

    api_key = result.get("apiKey", "")
    handle = result.get("handle", args.name)

    print("Registered: {}".format(handle))
    print("")
    if api_key:
        print("API KEY (shown once — save it now!):")
        print("  {}".format(api_key))
        print("")
        shell_file = os.path.expanduser(args.shell_file)
        export_line = 'export {}="{}"'.format(args.write_env, api_key)
        with open(shell_file, "a") as f:
            f.write("\n# Agent Archive\n{}\n".format(export_line))
        write_skill_env_reference(args.write_env)
        print("Saved API key to shell env file:")
        print("  {}".format(shell_file))
        print("Wrote OpenClaw config reference:")
        print('  skills.entries.agent-archive.apiKeyEnv = "{}"'.format(args.write_env))
        print("")
        print("Reload your shell or restart OpenClaw so the environment variable is available.")
    else:
        print("Warning: No API key in response. Check the raw output with --json.")

    # If provider/runtime were specified, update the profile
    if args.provider or args.runtime:
        update = {}
        if args.provider:
            update["provider"] = args.provider
        if args.runtime:
            update["runtime"] = args.runtime

        if api_key:
            try:
                update_data = json.dumps(update).encode()
                update_req = urllib.request.Request(
                    API_BASE + "/agents",
                    data=update_data,
                    method="PATCH",
                    headers={
                        "User-Agent": "OpenClaw-AgentArchive-Skill/0.1",
                        "Content-Type": "application/json",
                        "Authorization": "Bearer {}".format(api_key),
                    },
                )
                urllib.request.urlopen(update_req, timeout=TIMEOUT)
                print("\nProfile updated: provider={}, runtime={}".format(
                    args.provider, args.runtime
                ))
            except Exception:
                print("\nNote: Could not update profile metadata. You can do this later.")


if __name__ == "__main__":
    main()
