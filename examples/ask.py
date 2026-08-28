#!/usr/bin/env python3
"""
ask.py — chat with a DeepSeek Harness agent through dsh-api-gateway.

Standard library only (Python 3.8+): no pip install, runs on Linux, macOS and
Windows. This is the reference client — it exercises every endpoint a normal
caller needs (claim a key, create or adopt a session, send a message, stream the
reply over SSE, fall back to polling the history) and is meant to be read as
much as run.

  ./examples/ask.py "介绍一下你自己"        # ask once, print the answer
  ./examples/ask.py                        # interactive: many turns, one session
  ./examples/ask.py --list                 # what sessions can I see?
  ./examples/ask.py -s <id> "继续刚才的话题"  # keep talking in a GUI session

Notices (claimed key, session id, adopt mode) go to stderr and the answer goes
to stdout, so `ask.py "..." > answer.txt` keeps just the answer.

Exit codes: 0 ok, 1 request/usage error, 2 timeout, 130 interrupted.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

DEFAULT_BASE = os.environ.get("DSH_AGW_BASE", "http://127.0.0.1:3080/api-gw/v1")
DEFAULT_TIMEOUT = 300


class GatewayError(RuntimeError):
    """An HTTP error carrying the gateway's own JSON error payload."""


def _note(message: str, *, quiet: bool = False) -> None:
    if not quiet:
        print(message, file=sys.stderr, flush=True)


def request(method, url, *, key=None, body=None, timeout=30, stream=False):
    """One HTTP round trip. Returns parsed JSON, or the live response if stream."""
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        # Always declare the charset: the gateway decodes the body accordingly
        # (UTF-8 by default, GBK-tolerant), which is what keeps CJK prompts intact.
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    if key:
        headers["Authorization"] = f"Bearer {key}"
    if stream:
        headers["Accept"] = "text/event-stream"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        response = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as error:  # the gateway answers errors in JSON
        raw = error.read().decode("utf-8", "replace")
        try:
            detail = json.dumps(json.loads(raw), ensure_ascii=False)
        except ValueError:
            detail = raw.strip()
        raise GatewayError(f"{method} {url} -> {error.code} {detail}") from None
    except urllib.error.URLError as error:
        raise GatewayError(f"{method} {url} -> {error.reason} (is dsh running?)") from None
    if stream:
        return response
    with response:
        text = response.read().decode("utf-8", "replace")
    return json.loads(text) if text.strip() else {}


def resolve_key(args):
    """Use the supplied key, else claim one — POST /key works only while unclaimed."""
    if args.key:
        return args.key
    claimed = request("POST", f"{args.base}/key")["apiKey"]
    _note(f"claimed API key: {claimed}", quiet=args.quiet)
    _note("  reuse it via DSH_AGW_KEY or --key (a second claim is refused)", quiet=args.quiet)
    return claimed


def open_session(args, key):
    """Adopt the requested session, or create a fresh one."""
    if args.session:
        adopted = request("POST", f"{args.base}/sessions/{args.session}/adopt", key=key)
        _note(f"adopted {args.session} (mode={adopted['mode']}, cwd={adopted['cwd']})", quiet=args.quiet)
        return args.session
    body = {}
    for field in ("provider", "model", "cwd"):
        value = getattr(args, field)
        if value:
            body[field] = value
    created = request("POST", f"{args.base}/sessions", key=key, body=body)
    workspace = created.get("workspace") or {}
    _note(
        f"session {created['sessionId']} ({created['provider']}/{created['model']}"
        f", workspace={workspace.get('title', '-')})",
        quiet=args.quiet,
    )
    return created["sessionId"]


def sse_events(response):
    """Yield parsed `data:` frames; `: ping` heartbeats and blank lines are skipped."""
    for raw in response:
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        if not line.startswith("data: "):
            continue
        try:
            yield json.loads(line[6:])
        except ValueError:
            continue


def stream_turn(args, key, session, prompt):
    """Attach the stream, send the prompt, print the reply as it arrives.

    The stream is attached BEFORE the message is sent on purpose: the server
    ends a stream at `turn_end`, so a client that attaches after the turn
    finished would wait for an event that will never come. Attaching early
    costs nothing — the first frame (`hello`) replays the history so far.
    """
    response = request("GET", f"{args.base}/sessions/{session}/stream", key=key,
                       timeout=args.timeout, stream=True)
    answer = ""
    try:
        request("POST", f"{args.base}/sessions/{session}/messages", key=key,
                body={"content": prompt})
        for event in sse_events(response):
            kind = event.get("kind")
            if kind == "chunk":
                chunk = event.get("chunk") or {}
                if chunk.get("type") == "text-delta":
                    print(chunk["text"], end="", flush=True)
                elif chunk.get("type") == "reasoning-delta" and args.reasoning:
                    print(chunk["text"], end="", file=sys.stderr, flush=True)
            elif kind == "message":
                answer = event.get("text") or ""
            elif kind == "turn_end":
                if event.get("reason") != "completed":
                    _note(f"\nturn ended: {event.get('reason')} {event.get('detail') or ''}",
                          quiet=args.quiet)
                break
        print()
    except KeyboardInterrupt:
        request("POST", f"{args.base}/sessions/{session}/cancel", key=key)
        _note("\ncancelled", quiet=args.quiet)
        raise
    finally:
        response.close()
    return answer


def poll_turn(args, key, session, prompt):
    """No SSE: send, then poll the history until this turn produces a reply."""
    seen = len(history_messages(args, key, session))
    request("POST", f"{args.base}/sessions/{session}/messages", key=key,
            body={"content": prompt})
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        time.sleep(2)
        messages = history_messages(args, key, session)
        if len(messages) > seen:
            reply = messages[-1]
            if args.reasoning and reply.get("reasoning"):
                print(reply["reasoning"], file=sys.stderr)
            print(reply.get("text") or "")
            return reply.get("text") or ""
    raise TimeoutError(f"no reply within {args.timeout}s")


def history_messages(args, key, session):
    events = request("GET", f"{args.base}/sessions/{session}/history", key=key)["events"]
    return [event for event in events if event.get("kind") == "message"]


def ask(args, key, session, prompt):
    return poll_turn(args, key, session, prompt) if args.no_stream else stream_turn(args, key, session, prompt)


def interactive(args, key, session):
    _note("interactive mode — empty line or Ctrl-D to quit, Ctrl-C aborts a turn",
          quiet=args.quiet)
    while True:
        try:
            prompt = input("> " if not args.quiet else "")
        except EOFError:
            print(file=sys.stderr)
            return 0
        if not prompt.strip():
            return 0
        try:
            ask(args, key, session, prompt)
        except KeyboardInterrupt:
            continue
        except TimeoutError as error:
            _note(str(error), quiet=args.quiet)


def show_list(args, key):
    sessions = request("GET", f"{args.base}/sessions/discover", key=key)["sessions"]
    if not sessions:
        print("(no sessions)")
        return 0
    width = max(len(s["sessionId"]) for s in sessions)
    for s in sessions:
        state = "live" if s["live"] else ("saved" if s["persisted"] else "-")
        print(f"{s['sessionId']:<{width}}  {state:<5}  {s.get('title') or '(untitled)'}")
    return 0


def build_parser():
    parser = argparse.ArgumentParser(
        prog="ask.py",
        description="Ask a DeepSeek Harness agent a question through dsh-api-gateway.",
        epilog="With no prompt, ask.py stays interactive and reuses one session.",
    )
    parser.add_argument("prompt", nargs="*", help="the question; omit for interactive mode")
    parser.add_argument("-b", "--base", default=DEFAULT_BASE,
                        help=f"gateway base URL (env DSH_AGW_BASE, default {DEFAULT_BASE})")
    parser.add_argument("-k", "--key", default=os.environ.get("DSH_AGW_KEY", ""),
                        help="API key (env DSH_AGW_KEY); claimed via POST /key when unset")
    parser.add_argument("-s", "--session", default="",
                        help="talk to an existing session id (adopts it: live co-drive or cold resume)")
    parser.add_argument("-c", "--cwd", default="",
                        help="working directory for a new session (decides its workspace)")
    parser.add_argument("-p", "--provider", default="", help="LLM provider for a new session")
    parser.add_argument("-m", "--model", default="", help="model for a new session")
    parser.add_argument("--no-stream", action="store_true",
                        help="skip SSE; poll GET /history for the final answer instead")
    parser.add_argument("--reasoning", action="store_true",
                        help="also print the thinking trace (to stderr)")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                        help=f"seconds to wait for one turn (default {DEFAULT_TIMEOUT})")
    parser.add_argument("-q", "--quiet", action="store_true",
                        help="answer only: suppress the stderr notices")
    parser.add_argument("-l", "--list", action="store_true", dest="list_sessions",
                        help="list every session the gateway can see, then exit")
    parser.add_argument("--health", action="store_true",
                        help="print GET /health (needs no key), then exit")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if args.health:
            print(json.dumps(request("GET", f"{args.base}/health"), ensure_ascii=False, indent=2))
            return 0
        key = resolve_key(args)
        if args.list_sessions:
            return show_list(args, key)
        session = open_session(args, key)
        if not args.prompt:
            return interactive(args, key, session)
        ask(args, key, session, " ".join(args.prompt))
        return 0
    except GatewayError as error:
        print(f"ask.py: {error}", file=sys.stderr)
        return 1
    except TimeoutError as error:
        print(f"ask.py: {error}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
