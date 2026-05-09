#!/usr/bin/env python3
"""Convert a markdown file to a new Notion page under a parent page.

Usage:
  NOTION_TOKEN=... NOTION_PARENT_PAGE_ID=... python3 md_to_notion.py path/to/file.md "Page Title"
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
import urllib.error
from typing import Any

NOTION_TOKEN = os.environ["NOTION_TOKEN"]
NOTION_PARENT = os.environ["NOTION_PARENT_PAGE_ID"]
NOTION_VERSION = "2022-06-28"
API = "https://api.notion.com/v1"


# ─────────────────── HTTP ───────────────────

def api(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {NOTION_TOKEN}")
    req.add_header("Notion-Version", NOTION_VERSION)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", "replace")
        raise SystemExit(f"Notion API {method} {path} failed: HTTP {e.code}\n{msg}")


# ─────────────────── Inline rich_text ───────────────────

INLINE_TOKEN_RE = re.compile(
    r"\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*"
)


def rich_text(text: str) -> list[dict]:
    out: list[dict] = []
    pos = 0
    for m in INLINE_TOKEN_RE.finditer(text):
        if m.start() > pos:
            out.append(_plain(text[pos:m.start()]))
        link_label, link_url, code, bold, italic = m.groups()
        if link_label is not None:
            out.append({
                "type": "text",
                "text": {"content": link_label, "link": {"url": link_url}},
            })
        elif code is not None:
            out.append({
                "type": "text",
                "text": {"content": code},
                "annotations": {"code": True},
            })
        elif bold is not None:
            out.append({
                "type": "text",
                "text": {"content": bold},
                "annotations": {"bold": True},
            })
        elif italic is not None:
            out.append({
                "type": "text",
                "text": {"content": italic},
                "annotations": {"italic": True},
            })
        pos = m.end()
    if pos < len(text):
        out.append(_plain(text[pos:]))
    if not out:
        out = [_plain(text)]
    return out


def _plain(text: str) -> dict:
    return {"type": "text", "text": {"content": text}}


# ─────────────────── Block builders ───────────────────

def heading(level: int, text: str) -> dict:
    key = f"heading_{min(level, 3)}"
    return {"object": "block", "type": key, key: {"rich_text": rich_text(text)}}


def paragraph(text: str) -> dict:
    return {"object": "block", "type": "paragraph", "paragraph": {"rich_text": rich_text(text)}}


def bulleted(text: str) -> dict:
    return {"object": "block", "type": "bulleted_list_item", "bulleted_list_item": {"rich_text": rich_text(text)}}


def numbered(text: str) -> dict:
    return {"object": "block", "type": "numbered_list_item", "numbered_list_item": {"rich_text": rich_text(text)}}


def quote(text: str) -> dict:
    return {"object": "block", "type": "quote", "quote": {"rich_text": rich_text(text)}}


def code_block(content: str, lang: str) -> dict:
    return {
        "object": "block",
        "type": "code",
        "code": {
            "rich_text": [_plain(content)],
            "language": _normalize_lang(lang),
        },
    }


def divider() -> dict:
    return {"object": "block", "type": "divider", "divider": {}}


def table(rows: list[list[str]]) -> dict:
    if not rows:
        return paragraph("(empty table)")
    width = max(len(r) for r in rows)
    notion_rows = []
    for r in rows:
        cells = [rich_text(c) for c in r]
        while len(cells) < width:
            cells.append([_plain("")])
        notion_rows.append({
            "object": "block",
            "type": "table_row",
            "table_row": {"cells": cells},
        })
    return {
        "object": "block",
        "type": "table",
        "table": {
            "table_width": width,
            "has_column_header": True,
            "has_row_header": False,
            "children": notion_rows,
        },
    }


def _normalize_lang(lang: str) -> str:
    lang = (lang or "").lower().strip()
    allowed = {
        "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++", "c#",
        "css", "dart", "diff", "docker", "elixir", "elm", "erlang", "flow", "fortran",
        "f#", "gherkin", "glsl", "go", "graphql", "groovy", "haskell", "html", "java",
        "javascript", "json", "julia", "kotlin", "latex", "less", "lisp", "livescript",
        "lua", "makefile", "markdown", "markup", "matlab", "mermaid", "nix", "objective-c",
        "ocaml", "pascal", "perl", "php", "plain text", "powershell", "prolog", "protobuf",
        "python", "r", "reason", "ruby", "rust", "sass", "scala", "scheme", "scss", "shell",
        "sql", "swift", "typescript", "vb.net", "verilog", "vhdl", "visual basic", "webassembly",
        "xml", "yaml",
    }
    if lang in allowed:
        return lang
    aliases = {"sh": "shell", "ts": "typescript", "py": "python", "md": "markdown", "yml": "yaml"}
    return aliases.get(lang, "plain text")


# ─────────────────── Markdown parser ───────────────────

def parse_markdown(md: str) -> list[dict]:
    lines = md.split("\n")
    blocks: list[dict] = []
    i = 0
    while i < len(lines):
        line = lines[i]

        # blank
        if not line.strip():
            i += 1
            continue

        # code fence
        if line.startswith("```"):
            lang = line[3:].strip()
            buf: list[str] = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                buf.append(lines[i])
                i += 1
            blocks.append(code_block("\n".join(buf), lang))
            i += 1  # closing ```
            continue

        # heading
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            level = len(m.group(1))
            blocks.append(heading(level, m.group(2).strip()))
            i += 1
            continue

        # horizontal rule
        if re.match(r"^[-*_]{3,}\s*$", line):
            blocks.append(divider())
            i += 1
            continue

        # blockquote
        if line.startswith("> "):
            quote_lines = []
            while i < len(lines) and (lines[i].startswith("> ") or lines[i] == ">"):
                quote_lines.append(lines[i][2:] if lines[i].startswith("> ") else "")
                i += 1
            blocks.append(quote(" ".join(l for l in quote_lines if l).strip()))
            continue

        # table — header row + separator row + body rows
        if "|" in line and i + 1 < len(lines) and re.match(r"^\s*\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?\s*$", lines[i + 1]):
            rows = []
            while i < len(lines) and "|" in lines[i]:
                if re.match(r"^\s*\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?\s*$", lines[i]):
                    i += 1
                    continue
                cells = [c.strip() for c in re.split(r"\s*\|\s*", lines[i].strip().strip("|"))]
                rows.append(cells)
                i += 1
            blocks.append(table(rows))
            continue

        # bulleted list
        if re.match(r"^[-*]\s+", line):
            while i < len(lines) and re.match(r"^[-*]\s+", lines[i]):
                blocks.append(bulleted(re.sub(r"^[-*]\s+", "", lines[i])))
                i += 1
            continue

        # numbered list
        if re.match(r"^\d+\.\s+", line):
            while i < len(lines) and re.match(r"^\d+\.\s+", lines[i]):
                blocks.append(numbered(re.sub(r"^\d+\.\s+", "", lines[i])))
                i += 1
            continue

        # paragraph (collect contiguous non-empty, non-special lines)
        para_lines = [line]
        i += 1
        while (
            i < len(lines)
            and lines[i].strip()
            and not lines[i].startswith(("#", ">", "- ", "* ", "```"))
            and not re.match(r"^\d+\.\s+", lines[i])
            and "|" not in lines[i]
        ):
            para_lines.append(lines[i])
            i += 1
        blocks.append(paragraph(" ".join(l.strip() for l in para_lines)))

    return blocks


# ─────────────────── Main ───────────────────

def chunked(seq: list, n: int):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def main(md_path: str, title: str) -> None:
    with open(md_path, "r", encoding="utf-8") as f:
        md = f.read()

    blocks = parse_markdown(md)

    # Notion: create_page max children = 100
    first_chunk = blocks[:100]
    rest = blocks[100:]

    page = api("POST", "/pages", {
        "parent": {"page_id": NOTION_PARENT},
        "properties": {
            "title": [{"type": "text", "text": {"content": title}}],
        },
        "children": first_chunk,
    })
    page_id = page["id"]
    page_url = page.get("url", "")
    print(f"created: {page_url}", flush=True)

    # Append remaining blocks in chunks of 100
    for chunk in chunked(rest, 100):
        api("PATCH", f"/blocks/{page_id}/children", {"children": chunk})
        print(f"appended {len(chunk)} blocks", flush=True)

    print(f"done: {page_url}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: md_to_notion.py <md_path> <page_title>", file=sys.stderr)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
