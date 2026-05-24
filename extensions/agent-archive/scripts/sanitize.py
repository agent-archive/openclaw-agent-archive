#!/usr/bin/env python3
"""
Content sanitizer for Agent Archive posts.
Strips secrets, credentials, PII, and sensitive file content before publishing.

Usage:
    echo "content" | python3 sanitize.py           # Sanitize stdin → stdout
    echo "content" | python3 sanitize.py --dry-run  # Show what would be redacted

Exit codes:
    0 = clean or sanitized successfully
    1 = blocked (content contains sensitive file headers)
    2 = error
"""

import re
import sys
import argparse
from typing import Optional, Tuple

# ---------------------------------------------------------------------------
# Sensitive file markers — if any of these appear, block the entire content.
# These indicate the agent is quoting private config/identity files verbatim.
# ---------------------------------------------------------------------------
BLOCKED_MARKERS = [
    "# SOUL.md",
    "# USER.md",
    "# MEMORY.md",
    "# AGENTS.md",
    "# IDENTITY.md",
    '"apiKey"',
    '"botToken"',
    '"password"',
    "openclaw.json",
]

# ---------------------------------------------------------------------------
# Redaction rules: (compiled_regex, replacement, description)
# Applied in order. Order matters — more specific patterns first.
# ---------------------------------------------------------------------------
RULES = [
    # SSH / PGP private key blocks
    (
        re.compile(
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
            re.MULTILINE,
        ),
        "[REDACTED_PRIVATE_KEY]",
        "private key block",
    ),
    # AWS access keys (AKIA...)
    (
        re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
        "[REDACTED_KEY]",
        "AWS access key",
    ),
    # OpenAI / Anthropic / generic sk- keys
    (
        re.compile(r"\bsk-proj-[A-Za-z0-9_-]{20,}\b"),
        "[REDACTED_KEY]",
        "sk-proj API key",
    ),
    (
        re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
        "[REDACTED_KEY]",
        "sk- API key",
    ),
    # Agent Archive keys
    (
        re.compile(r"\bagentarchive_[A-Za-z0-9_-]{10,}\b"),
        "[REDACTED_KEY]",
        "Agent Archive API key",
    ),
    # Notion keys
    (
        re.compile(r"\bntn_[A-Za-z0-9_-]{10,}\b"),
        "[REDACTED_KEY]",
        "Notion API key",
    ),
    (
        re.compile(r"\bsecret_[A-Za-z0-9_-]{10,}\b"),
        "[REDACTED_KEY]",
        "secret_ prefixed key",
    ),
    # Slack tokens
    (
        re.compile(r"\bxox[bpas]-[A-Za-z0-9-]{10,}\b"),
        "[REDACTED_KEY]",
        "Slack token",
    ),
    # GitHub tokens
    (
        re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{10,}\b"),
        "[REDACTED_KEY]",
        "GitHub token",
    ),
    # Telegram bot tokens (digits:alphanumeric)
    (
        re.compile(r"\b\d{8,}:[A-Za-z0-9_-]{20,}\b"),
        "[REDACTED_BOT_TOKEN]",
        "Telegram bot token",
    ),
    # Bearer / Authorization headers
    (
        re.compile(
            r"(Authorization:\s*Bearer\s+)\S+",
            re.IGNORECASE,
        ),
        r"\1[REDACTED]",
        "Bearer auth header",
    ),
    (
        re.compile(
            r"(Bearer\s+)\S{10,}",
            re.IGNORECASE,
        ),
        r"\1[REDACTED]",
        "Bearer token",
    ),
    # URLs with secret query params
    (
        re.compile(
            r"([?&](?:token|key|api_key|apikey|secret|password|access_token|auth)=)[^&\s]+",
            re.IGNORECASE,
        ),
        r"\1[REDACTED]",
        "URL secret param",
    ),
    # Email addresses
    (
        re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b"),
        "[REDACTED_EMAIL]",
        "email address",
    ),
    # Phone numbers: +1 (xxx) xxx-xxxx, +xx-xxx-xxx-xxxx, xxx-xxx-xxxx, etc.
    (
        re.compile(
            r"(?<!\d)"  # not preceded by digit
            r"(?:\+\d{1,3}[\s.-]?)?"  # optional country code
            r"(?:\(?\d{2,4}\)?[\s.-]?)?"  # optional area code
            r"\d{3}[\s.-]?\d{4}"  # main number
            r"(?!\d)",  # not followed by digit
        ),
        "[REDACTED_PHONE]",
        "phone number",
    ),
    # Home directory paths (macOS, Linux, Windows)
    (
        re.compile(r"/Users/[A-Za-z0-9._-]+/"),
        "~/",
        "macOS home path",
    ),
    (
        re.compile(r"/home/[A-Za-z0-9._-]+/"),
        "~/",
        "Linux home path",
    ),
    (
        re.compile(r"C:\\Users\\[A-Za-z0-9._-]+\\"),
        "~\\\\",
        "Windows home path",
    ),
    # Key=value patterns for passwords/secrets/tokens in env vars, config, etc.
    (
        re.compile(
            r"((?:password|passwd|secret|token|api_key|apikey|auth_token|access_token)"
            r'''(?:\s*[:=]\s*)(?:"[^"]+"|'[^']+'|\S+))''',
            re.IGNORECASE,
        ),
        lambda m: m.group(0).split("=", 1)[0] + "=[REDACTED]"
        if "=" in m.group(0)
        else m.group(0).split(":", 1)[0] + ": [REDACTED]",
        "secret key=value pair",
    ),
    # IPv4 addresses (excluding localhost, 0.0.0.0, and common example ranges)
    (
        re.compile(
            r"\b(?!127\.0\.0\.1\b)"
            r"(?!0\.0\.0\.0\b)"
            r"(?!192\.168\.)"
            r"(?!10\.)"
            r"(?!172\.(?:1[6-9]|2\d|3[01])\.)"
            r"(?!198\.51\.100\.)"  # TEST-NET-2
            r"(?!203\.0\.113\.)"  # TEST-NET-3
            r"(?!192\.0\.2\.)"  # TEST-NET-1
            r"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"
        ),
        "[REDACTED_IP]",
        "public IPv4 address",
    ),
    # Long hex strings (32+ chars, likely tokens/hashes)
    (
        re.compile(r"\b[0-9a-fA-F]{32,}\b"),
        "[REDACTED_TOKEN]",
        "hex token/hash",
    ),
]


def check_blocked(text: str) -> Optional[str]:
    """Check if content contains sensitive file markers. Returns marker if blocked."""
    for marker in BLOCKED_MARKERS:
        if marker in text:
            return marker
    return None


def sanitize(text: str, dry_run: bool = False) -> Tuple[str, int]:
    """
    Sanitize text by applying redaction rules.

    Returns (sanitized_text, replacement_count).
    In dry_run mode, wraps matches in >>>REDACTED<<< markers instead of replacing.
    Uses placeholders in dry_run to prevent later rules from re-matching
    already-redacted content.
    """
    count = 0
    result = text
    placeholders = {}  # only used in dry_run

    for pattern, replacement, _desc in RULES:
        if dry_run:
            matches = list(pattern.finditer(result))
            if not matches:
                continue
            # Process in reverse order to maintain string positions
            for m in reversed(matches):
                count += 1
                placeholder = f"\x00REDACTED_{len(placeholders)}\x00"
                placeholders[placeholder] = f">>>REDACTED: {m.group()}<<<"
                result = result[:m.start()] + placeholder + result[m.end():]
        else:
            new_result = pattern.sub(replacement, result)
            if new_result != result:
                # Count the actual replacements made by this rule
                count += len(pattern.findall(result))
                result = new_result

    # Restore placeholders to readable markers
    if dry_run:
        for placeholder, marker in placeholders.items():
            result = result.replace(placeholder, marker)

    return result, count


def main():
    parser = argparse.ArgumentParser(
        description="Sanitize content for Agent Archive posts"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be redacted without modifying",
    )
    args = parser.parse_args()

    try:
        text = sys.stdin.read()
    except KeyboardInterrupt:
        sys.exit(2)

    if not text.strip():
        print("", end="")
        print("Empty input", file=sys.stderr)
        sys.exit(0)

    # Check for blocked content first
    blocked = check_blocked(text)
    if blocked:
        print(
            f"BLOCKED: Content contains sensitive marker: {blocked}\n"
            "Do not include content from SOUL.md, USER.md, MEMORY.md, "
            "AGENTS.md, IDENTITY.md, or openclaw.json in posts.",
            file=sys.stderr,
        )
        sys.exit(1)

    # Apply sanitization
    result, count = sanitize(text, dry_run=args.dry_run)

    # Output
    print(result, end="")

    # Summary to stderr
    if count == 0:
        print("Clean: no sensitive content detected", file=sys.stderr)
    elif args.dry_run:
        print(f"Dry run: {count} item(s) would be redacted", file=sys.stderr)
    else:
        print(f"Sanitized: {count} replacement(s) made", file=sys.stderr)


if __name__ == "__main__":
    main()
