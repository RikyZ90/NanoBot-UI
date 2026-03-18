#!/usr/bin/env python3
"""Semplice server per nano-ui.

Fornisce:
- static file (index.html, style.css, app.js, settings.js)
- endpoint API /api/v1/agent che esegue `nanobot agent --message` per ottenere una risposta.
- endpoint API /api/v1/config per leggere/scrivere config.json.
- endpoint API /api/v1/sessions per gestire la cronologia.
- endpoint API /api/v1/restart per il riavvio globale.
- endpoint API /api/v1/telegram/webhook per ricevere messaggi da Telegram e inoltrarli a nanobot.
  Token e allowFrom vengono letti da config.json (channels.telegram) ad ogni richiesta.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import glob
import logging
import threading
import urllib.request
import urllib.error
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

# Setup logging
logging.basicConfig(level=logging.DEBUG, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

WORKDIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = WORKDIR / "config.json"
CONFIG_PATH = Path(os.environ.get("NANO_CONFIG_PATH", "/app/config.json"))
if not CONFIG_PATH.exists() and DEFAULT_CONFIG.exists():
    CONFIG_PATH = DEFAULT_CONFIG

SESSIONS_DIR = Path(os.environ.get("NANO_SESSIONS_DIR", str(WORKDIR / "sessions")))
SESSIONS_DIR.mkdir(exist_ok=True, parents=True)


# ── Telegram config helpers ──────────────────────────────────────────────────

def _load_telegram_config() -> tuple[str, list[str]]:
    """Read token and allowFrom from config.json channels.telegram.

    Matches nanobot's native config format:
        {
          "channels": {
            "telegram": {
              "enabled": true,
              "token": "123456:ABC...",
              "allowFrom": ["987654321", "111222333"]  // optional
            }
          }
        }

    Returns (token, allow_from_list). token may be empty string;
    allow_from_list is an empty list if not set (= allow all).
    """
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        tg = config.get("channels", {}).get("telegram", {})
        token = str(tg.get("token") or "").strip()
        raw_allow = tg.get("allowFrom") or []
        allow_from = [str(x).strip() for x in raw_allow if str(x).strip()]
        return token, allow_from
    except Exception as e:
        logger.warning(f"Could not read Telegram config from config.json: {e}")
        return "", []


def _telegram_send(chat_id: str | int, text: str, bot_token: str) -> None:
    """Send a text message to a Telegram chat via Bot API."""
    if not bot_token:
        logger.warning("bot_token empty, cannot send Telegram reply")
        return
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    # Telegram messages max 4096 chars — split if needed
    chunks = [text[i:i + 4096] for i in range(0, max(len(text), 1), 4096)]
    for chunk in chunks:
        payload = json.dumps({"chat_id": chat_id, "text": chunk, "parse_mode": "Markdown"}).encode("utf-8")
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                logger.debug(f"Telegram sendMessage status: {resp.status}")
        except urllib.error.URLError as e:
            logger.error(f"Telegram sendMessage failed: {e}")


def _run_nanobot(message: str, session: str) -> str:
    """Run nanobot agent via docker exec and return the clean response text."""
    cmd = [
        "docker", "exec", "-i", "nanobot",
        "/usr/local/bin/python", "-m", "nanobot", "agent",
        "-m", message, "--session", session, "--no-logs"
    ]
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    skip_prefixes = ("Hint:", "`memoryWindow`", "\U0001f408 nanobot", "\U0001f43e nanobot")
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120, env=env)
        lines = []
        for line in proc.stdout.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            if any(stripped.startswith(p) for p in skip_prefixes):
                continue
            markers = ["\u21b3", "Thinking...", "Tool", "Calling", "Running", "Analyzing"]
            if any(m in line for m in markers) and line.startswith("  "):
                continue
            lines.append(line.rstrip())
        result = "\n".join(lines).strip()
        if proc.returncode != 0 and not result:
            result = f"Errore nanobot (exit {proc.returncode})"
        return result or "(nessuna risposta)"
    except subprocess.TimeoutExpired:
        return "Timeout: nanobot non ha risposto in tempo."
    except Exception as e:
        logger.exception("_run_nanobot failed")
        return f"Errore interno: {e}"


class NanoUIHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WORKDIR), **kwargs)

    def _parse_request_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length == 0:
                logger.warning("Empty body or missing Content-Length")
                return {}
            body = self.rfile.read(length)
            decoded = body.decode("utf-8")
            logger.debug(f"Parsed body: {decoded}")
            return json.loads(decoded)
        except Exception as e:
            logger.error(f"Error parsing request body: {e}")
            return {"error": "invalid json", "detail": str(e)}

    def do_GET(self):
        parsed = urlparse(self.path)
        logger.debug(f"GET {parsed.path}")
        if parsed.path == "/api/v1/config":
            return self._handle_config_get()
        return super().do_GET()

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            logger.debug(f"POST {parsed.path}")
            if parsed.path == "/api/v1/agent":
                self._handle_single()
            elif parsed.path == "/api/v1/config":
                self._handle_config_post()
            elif parsed.path == "/api/v1/restart":
                self._handle_restart()
            elif parsed.path == "/api/v1/telegram/webhook":
                self._handle_telegram_webhook()
            elif parsed.path == "/api/v1/sessions":
                data = self._parse_request_body()
                action = data.get("action")
                logger.debug(f"Session action: {action}")
                if action == "list":
                    self._handle_sessions_list()
                elif action == "create":
                    self._handle_sessions_create(data)
                elif action == "load":
                    self._handle_sessions_load(data.get("id"))
                elif action == "save":
                    self._handle_sessions_save(data.get("id"), data.get("messages"), data.get("title"))
                elif action == "delete":
                    self._handle_sessions_delete(data.get("id"))
                elif action == "compact":
                    self._handle_sessions_compact(data.get("id"), data.get("messages"))
                else:
                    logger.warning(f"Unknown session action: {action}")
                    self.send_error(HTTPStatus.BAD_REQUEST, f"Unknown session action: {action}")
            else:
                logger.warning(f"Path not found: {parsed.path}")
                self.send_error(HTTPStatus.NOT_FOUND, f"API endpoint not found: {parsed.path}")
        except Exception as e:
            logger.exception("Internal error in do_POST")
            self._send_json({"ok": False, "error": "internal", "detail": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    # ── Telegram webhook ────────────────────────────────────────────────────

    def _handle_telegram_webhook(self):
        """Receive a Telegram Update, forward the message to nanobot, reply.

        Config is read live from config.json — no restart needed when
        token or allowFrom change.
        Telegram expects 200 OK quickly; processing runs in a background thread.
        """
        token, allow_from = _load_telegram_config()
        if not token:
            logger.warning("Telegram webhook received but channels.telegram.token is not configured")
            return self._send_json({"ok": False, "error": "Telegram token not configured in config.json"})

        update = self._parse_request_body()
        if not update or "error" in update:
            return self._send_json({"ok": False, "error": "invalid update"})

        # Acknowledge immediately
        self._send_json({"ok": True})

        # Process in background
        t = threading.Thread(
            target=self._process_telegram_update,
            args=(update, token, allow_from),
            daemon=True,
        )
        t.start()

    def _process_telegram_update(self, update: dict, token: str, allow_from: list[str]) -> None:
        """Background: extract message text, run nanobot, reply to Telegram."""
        try:
            message = update.get("message") or update.get("edited_message")
            if not message:
                logger.debug("Telegram update has no message, skipping")
                return

            chat_id = message.get("chat", {}).get("id")
            text = message.get("text", "").strip()

            if not chat_id or not text:
                logger.debug("Telegram message missing chat_id or text, skipping")
                return

            # allowFrom whitelist — empty list means allow all
            if allow_from and str(chat_id) not in allow_from:
                logger.warning(f"Telegram message from unauthorized chat_id {chat_id}, ignoring")
                return

            session_key = f"telegram_{chat_id}"
            logger.info(f"Telegram [{chat_id}] -> nanobot: {text[:80]}")

            response = _run_nanobot(text, session_key)
            logger.info(f"Telegram [{chat_id}] <- nanobot: {response[:80]}")

            _telegram_send(chat_id, response, token)
        except Exception:
            logger.exception("_process_telegram_update failed")

    # ── Existing handlers ────────────────────────────────────────────────────

    def _handle_restart(self):
        try:
            logger.info("Restarting system...")
            subprocess.run(["docker", "restart", "nanobot"], check=True)
            self._send_json({"ok": True, "message": "System restarting..."})
            logger.info("Self-restarting UI server...")
            os.execv(sys.executable, [sys.executable] + sys.argv)
        except Exception as e:
            logger.error(f"Restart failed: {e}")
            self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def _handle_config_get(self):
        try:
            config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            return self._send_json({"ok": True, "config": config})
        except FileNotFoundError:
            return self._send_json({"ok": False, "error": "config not found"}, status=HTTPStatus.NOT_FOUND)
        except Exception as e:
            return self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def _handle_config_post(self):
        data = self._parse_request_body()
        config_payload = data.get("config")
        if not isinstance(config_payload, dict):
            return self._send_json({"error": "config must be an object"}, status=HTTPStatus.BAD_REQUEST)
        try:
            CONFIG_PATH.write_text(json.dumps(config_payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            return self._send_json({"ok": True})
        except Exception as e:
            return self._send_json({"ok": False, "error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def _handle_sessions_list(self):
        try:
            pattern = str(SESSIONS_DIR / "webui_*.jsonl")
            files = glob.glob(pattern)
            sessions = []
            for fpath in files:
                f = Path(fpath)
                session_id = f.stem
                title_path = SESSIONS_DIR / f"{session_id}.title"
                title = None
                if title_path.exists():
                    try:
                        title = title_path.read_text(encoding="utf-8").strip()
                    except: pass
                if not title:
                    title = session_id[:20]
                    try:
                        lines = f.read_text(encoding="utf-8").splitlines()
                        for line in lines:
                            if not line.strip(): continue
                            msg = json.loads(line)
                            if msg.get("role") == "system" and msg.get("type") == "metadata":
                                continue
                            if msg.get("role") == "user":
                                content = msg.get("content", "")
                                title = content[:50] + "..." if len(content) > 50 else content
                                break
                    except: pass
                mtime = int(f.stat().st_mtime * 1000)
                sessions.append({"id": session_id, "title": title or "New chat", "updatedAt": mtime})
            sessions.sort(key=lambda x: x["updatedAt"], reverse=True)
            self._send_json({"sessions": sessions})
        except Exception as e:
            logger.error(f"Sessions list failed: {e}")
            self._send_json({"error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def _handle_sessions_create(self, data):
        session_id = f"webui_{int(time.time() * 1000000)}"
        fpath = SESSIONS_DIR / f"{session_id}.jsonl"
        fpath.write_text("", encoding="utf-8")
        self._send_json({"id": session_id, "title": "New chat", "updatedAt": int(time.time() * 1000)})

    def _handle_sessions_load(self, session_id):
        fpath = SESSIONS_DIR / f"{session_id}.jsonl"
        if not fpath.exists():
            return self._send_json({"messages": []})
        try:
            lines = fpath.read_text(encoding="utf-8").splitlines()
            messages = []
            for line in lines:
                if not line.strip():
                    continue
                m = json.loads(line)
                if not m or not isinstance(m, dict):
                    continue
                if m.get("role") == "system" and m.get("type") == "metadata":
                    continue
                messages.append(m)
            self._send_json({"messages": messages})
        except Exception as e:
            logger.error(f"Failed to load session {session_id}: {e}")
            self._send_json({"error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def _handle_sessions_save(self, session_id, messages, title=None):
        fpath = SESSIONS_DIR / f"{session_id}.jsonl"
        try:
            if title:
                title_path = SESSIONS_DIR / f"{session_id}.title"
                title_path.write_text(title, encoding="utf-8")
            with open(fpath, "w", encoding="utf-8") as f:
                if messages:
                    for m in messages:
                        if not m or not isinstance(m, dict):
                            continue
                        if m.get("role") == "system" and m.get("type") == "metadata":
                            continue
                        f.write(json.dumps(m, ensure_ascii=False) + "\n")
            self._send_json({"ok": True})
        except Exception as e:
            self._send_json({"error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

    def _handle_sessions_delete(self, session_id):
        fpath = SESSIONS_DIR / f"{session_id}.jsonl"
        if fpath.exists(): fpath.unlink()
        title_path = SESSIONS_DIR / f"{session_id}.title"
        if title_path.exists(): title_path.unlink()
        self._send_json({"ok": True})

    def _handle_sessions_compact(self, session_id, messages=None):
        """Archive a session into memory/HISTORY.md and clean up."""
        if messages is None:
            fpath = SESSIONS_DIR / f"{session_id}.jsonl"
            if not fpath.exists():
                return self._send_json({"error": "session not found"}, status=HTTPStatus.NOT_FOUND)
            try:
                lines = fpath.read_text(encoding="utf-8").splitlines()
                messages = [json.loads(line) for line in lines if line.strip()]
            except Exception as e:
                logger.exception("Error reading session file for compaction")
                return self._send_json({"error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
        else:
            if not isinstance(messages, list):
                return self._send_json({"error": "messages must be an array"}, status=HTTPStatus.BAD_REQUEST)

        if not messages:
            fpath = SESSIONS_DIR / f"{session_id}.jsonl"
            if fpath.exists():
                try:
                    fpath.unlink()
                except Exception:
                    pass
            return self._send_json({"ok": True, "message": "Empty session deleted"})

        title = session_id
        if messages and isinstance(messages[0], dict) and messages[0].get("role") == "user":
            content = messages[0].get("content", "")
            title = content[:50] + "..." if len(content) > 50 else content

        summary = ""
        try:
            logger.info(f"Generating synthesis for session {session_id}...")
            temp_file_created = False
            fpath = SESSIONS_DIR / f"{session_id}.jsonl"
            if not fpath.exists():
                fpath.write_text("\n".join(json.dumps(m, ensure_ascii=False) for m in messages) + "\n", encoding="utf-8")
                temp_file_created = True
            summary_cmd = [
                "docker", "exec", "-i", "nanobot",
                "/usr/local/bin/python", "-m", "nanobot", "agent",
                "-m", "Provide a extremely concise one-sentence summary (synthesis) of our conversation for the archival log. No noise, just the summary.",
                "--session", session_id, "--no-logs"
            ]
            proc = subprocess.run(summary_cmd, capture_output=True, text=True, timeout=20)
            if proc.returncode == 0:
                raw_sum = proc.stdout.strip()
                skip_prefixes = ("Hint:", "`memoryWindow`", "\U0001f408 nanobot", "\U0001f43e nanobot")
                sum_lines = []
                for sl in raw_sum.splitlines():
                    s_strip = sl.strip()
                    if not s_strip or any(s_strip.startswith(p) for p in skip_prefixes): continue
                    sum_lines.append(sl)
                summary = "\n".join(sum_lines).strip()
                logger.debug(f"Synthesis result: {summary}")
            if temp_file_created and fpath.exists():
                fpath.unlink()
        except Exception as se:
            logger.error(f"Synthesis failed: {se}")

        timestamp = time.strftime('%Y-%m-%d %H:%M')
        entry_lines = [f"[{timestamp}] Compacted session: {title}"]
        if summary:
            entry_lines.append(f"  [SYNTHESIS] {summary}")
        for m in messages:
            if not isinstance(m, dict):
                continue
            role = m.get("role", "unknown").upper()
            content = m.get("content", "")
            for line in (content.splitlines() if isinstance(content, str) else [str(content)]):
                entry_lines.append(f"  [{role}] {line}")
        entry_text = "\n".join(entry_lines) + "\n\n"

        memory_history = SESSIONS_DIR.parent / "memory" / "HISTORY.md"
        memory_history.parent.mkdir(parents=True, exist_ok=True)
        existing = ""
        if memory_history.exists():
            existing = memory_history.read_text(encoding="utf-8")
        try:
            memory_history.write_text(entry_text + existing, encoding="utf-8")
        except Exception as e:
            logger.exception("Failed to write to HISTORY.md")
            return self._send_json({"error": str(e)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)

        fpath = SESSIONS_DIR / f"{session_id}.jsonl"
        if fpath.exists():
            try:
                fpath.unlink()
            except Exception:
                pass

        self._send_json({"ok": True, "archived_to": str(memory_history), "summary": summary})

    def _handle_single(self):
        data = self._parse_request_body()
        inp = data.get("input")
        session = data.get("session") or "webui_direct"
        if not inp: return self._send_json({"error": "missing input"}, status=HTTPStatus.BAD_REQUEST)

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        cmd = [
            "docker", "exec", "-i", "nanobot",
            "/usr/local/bin/python", "-m", "nanobot", "agent",
            "-m", inp, "--session", session, "--no-logs"
        ]

        def send_event(event_type, payload):
            msg = f"event: {event_type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
            self.wfile.write(msg.encode("utf-8"))
            self.wfile.flush()

        try:
            env = os.environ.copy()
            env["PYTHONUNBUFFERED"] = "1"
            with subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=env) as proc:
                skip_prefixes = ("Hint:", "`memoryWindow`", "\U0001f408 nanobot", "\U0001f43e nanobot")
                content_lines = []
                is_capturing_content = False
                for line in proc.stdout:
                    logger.debug(f"NANOBOT-OUT: {repr(line)}")
                    stripped = line.strip()
                    if not stripped:
                        if is_capturing_content:
                            content_lines.append("")
                            send_event("chunk", {"content": "\n"})
                        continue
                    if any(stripped.startswith(p) for p in skip_prefixes):
                        continue
                    is_progress = False
                    if not is_capturing_content:
                        markers = ["\u21b3", "\u2192", "Thinking...", "Tool", "Calling", "Running", "Analyzing"]
                        if (line.startswith("  ") and not stripped.startswith("```")) or any(m in line for m in markers) or "thinking..." in stripped.lower():
                            is_progress = True
                    if is_progress:
                        clean = stripped
                        for sym in ["\u21b3", "\u2192"]: clean = clean.replace(sym, "")
                        send_event("progress", {"content": clean.strip() or stripped})
                        continue
                    is_capturing_content = True
                    content_lines.append(line.rstrip())
                    send_event("chunk", {"content": line})

                proc.wait()
                if proc.returncode != 0:
                    send_event("error", {"message": f"nanobot failed ({proc.returncode})"})
                while content_lines and not content_lines[0].strip(): content_lines.pop(0)
                while content_lines and not content_lines[-1].strip(): content_lines.pop()
                result = "\n".join(content_lines).strip()
                if result: send_event("final", {"result": result})
                self.wfile.write(b"event: end\ndata: {\"done\":true}\n\n")
                self.wfile.flush()
                self.close_connection = 1
        except Exception as e:
            logger.exception("Error in SSE stream")
            send_event("error", {"message": str(e)})
            self.close_connection = 1

    def _send_json(self, payload: dict, status: int = HTTPStatus.OK) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main(port: int = 18790):
    server = ThreadingHTTPServer(("0.0.0.0", port), NanoUIHandler)
    logger.info(f"nano-ui server running on http://localhost:{port}")
    token, allow_from = _load_telegram_config()
    if token:
        allow_info = f"allowFrom={allow_from}" if allow_from else "allowFrom=all"
        logger.info(f"Telegram bridge enabled ({allow_info}). Config from config.json.")
        logger.info("Register webhook: https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<YOUR_DOMAIN>/api/v1/telegram/webhook")
    else:
        logger.info("Telegram bridge disabled (channels.telegram.token not set in config.json)")
    try: server.serve_forever()
    except KeyboardInterrupt: pass


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    main(port=args.port)
