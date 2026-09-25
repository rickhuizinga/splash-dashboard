#!/usr/bin/env python3
"""Splash Engine dashboard backend.

Stdlib-only local proxy (127.0.0.1:8280) in front of the Splash inference
engine (127.0.0.1:8200). Serves a single static page plus two API routes:

  GET /            -> static files (index.html, app.js)
  GET /api/status  -> proxies /status from the engine, injecting the bearer
                      key from $SPLASH_API_KEY (never sent to the browser),
                      2 s cache, reduced payload. Emits an explicit
                      engine_down / auth state when the engine is bad.
  GET /api/log     -> Server-Sent Events stream following
                      ~/Library/Logs/splash/splash.{out,err}.log
                      (incremental, rotation-safe). ?since=tail:N replays the
                      last N buffered lines, then streams.

The API key is read from the environment only. Nothing that contains the key
is ever written to a client response.

Log-following semantics (verified on this box, 2026-09-24):
  launchd holds the log FDs open. newsyslog (/etc/newsyslog.d/splash.conf,
  1 MB trigger, 7 x bzip2) rotates by RENAME: splash.out.log ->
  splash.out.log.1 (+ older ones compressed), then touches an empty fresh
  splash.out.log. The ENGINE keeps writing to the renamed file (its FD is
  still open) for hours — a probe confirmed the touched fresh file stayed
  empty for 70 s while the renamed one grew. Therefore the follower tracks
  the *live file by content*: among the non-compressed siblings
  splash.out.log*, the one with the newest (mtime, size) that holds content.
  A plain path-follower would follow the empty fresh file after a rotation
  and miss every engine line until the engine restarts. The follower
  re-targets when the engine restarts and writes a fresh base-named file,
  draining the old file first, and emits a "rotation" SSE marker.
"""
import os
import sys
import json
import time
import uuid
import glob
import queue
import threading
import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------
BIND_HOST = "127.0.0.1"          # binding constraint: localhost only
BIND_PORT = 8280
ENGINE_HOST = "127.0.0.1"
ENGINE_PORT = 8200
ENGINE_PATH = "/status"
API_KEY = os.environ.get("SPLASH_API_KEY", "")
LOG_DIR = os.path.expanduser("~/Library/Logs/splash")
LOG_OUT = os.path.join(LOG_DIR, "splash.out.log")
LOG_ERR = os.path.join(LOG_DIR, "splash.err.log")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
LOG_BUFFER_MAX = 5000            # in-memory line cap (spec: 5,000)
STATUS_CACHE_TTL = 2.0           # seconds (spec: 2 s cache)
ENGINE_TIMEOUT = 5.0             # seconds per /status fetch
TAIL_TICK = 0.5                  # seconds between log-file polls


# --------------------------------------------------------------------------
# Log following
# --------------------------------------------------------------------------
class FileTail:
    """Follows the *live* file of one logical log stream (out or err).

    Resolves the live file by content each tick (see module docstring),
    follows it by inode, drains the old file on re-target, and survives
    in-place truncation. Never re-reads the whole file on each poll.
    """

    def __init__(self, name, base):
        self.name = name
        self.base = base
        self.dir = os.path.dirname(base)
        self.stem = os.path.basename(base)
        self.fh = None          # Optional[BinaryIO]; None until open()
        self.inode = None       # Optional[int]
        self.path = None        # Optional[str]
        self.offset = 0
        self.partial = b""

    # -- file discovery ----------------------------------------------------
    def _candidates(self):
        """(mtime, size, ino, path) for every non-compressed sibling."""
        out = []
        for p in glob.glob(os.path.join(self.dir, self.stem + "*")):
            if p.endswith((".bz2", ".gz")):
                continue
            try:
                st = os.stat(p)
            except OSError:
                continue
            if not os.path.isfile(p):
                continue
            out.append((st.st_mtime, st.st_size, st.st_ino, p))
        return out

    def resolve_live(self, require_content=True):
        """Path of the file the engine is currently writing to (or None)."""
        cands = self._candidates()
        if not cands:
            return None
        # newest (mtime, size) wins; the renamed, still-growing file beats
        # the freshly touched (empty) base after a newsyslog rotation.
        _, size, _, path = max(cands, key=lambda t: (t[0], t[1]))
        if require_content and size == 0:
            return None
        return path

    # -- handle management -------------------------------------------------
    def open(self, path, from_end=True):
        if self.fh is not None:
            try:
                self.fh.close()
            except OSError:
                pass
            self.fh = None
        try:
            f = open(path, "rb")
        except OSError:
            self.path = None
            self.inode = None
            return False
        st = os.fstat(f.fileno())
        self.inode = st.st_ino
        self.path = path
        if from_end:
            f.seek(0, os.SEEK_END)
        self.offset = f.tell()
        self.partial = b""
        self.fh = f
        return True

    def _read_handle(self):
        """Read all currently-available bytes from the open handle; return
        complete lines. Keeps self.partial as the in-flight fragment."""
        if self.fh is None:
            return []
        try:
            data = self.fh.read()
        except OSError:
            return []
        if not data:
            return []
        self.offset += len(data)
        buf = self.partial + data
        lines = buf.split(b"\n")
        self.partial = lines.pop()  # trailing fragment (incomplete line)
        out = []
        for ln in lines:
            s = ln.decode("utf-8", "replace").rstrip("\r")
            if s:
                out.append(s)
        return out

    # -- main tick ----------------------------------------------------------
    def read_new(self):
        """Return (lines, events) since the last tick.

        events: list of ("truncated", base) or ("reopened", from_base, to_base).
        """
        lines = []
        events = []
        if self.fh is None:
            live = self.resolve_live(require_content=False) or self.base
            if not self.open(live, from_end=False):
                return [], events
        # in-place truncation (size < offset, same inode): do NOT re-read the
        # tail we may already have emitted — resume from the new EOF instead.
        try:
            st = os.stat(self.path) if self.path else None
        except OSError:
            st = None
        if (st is not None and self.path and self.fh is not None
                and st.st_ino == self.inode and st.st_size < self.offset):
            self.fh.seek(0, os.SEEK_END)
            self.offset = self.fh.tell()
            self.partial = b""
            events.append(("truncated", self.name))
        # live-file re-resolution (engine restart writes a fresh base file)
        live = self.resolve_live(require_content=True)
        if live is not None:
            try:
                live_ino = os.stat(live).st_ino
            except OSError:
                live_ino = None
            if live_ino is not None and live_ino != self.inode:
                if self.fh is not None:
                    lines.extend(self._read_handle())  # drain old file
                    try:
                        self.fh.close()
                    except OSError:
                        pass
                    self.fh = None
                old = os.path.basename(self.path) if self.path else self.name
                if self.open(live, from_end=False):
                    events.append(
                        ("reopened", old, os.path.basename(live)))
        if self.fh is not None:
            lines.extend(self._read_handle())
        return lines, events

    @staticmethod
    def read_last_n(path, n):
        """One-shot read of the last n lines (used to seed the buffer)."""
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            return []
        lines = [ln.decode("utf-8", "replace").rstrip("\r")
                 for ln in data.split(b"\n")]
        lines = [ln for ln in lines if ln]
        return lines[-n:] if n > 0 else []


class LogBroadcaster:
    """Holds a bounded buffer of recent log lines and fans new lines out to
    every connected SSE client."""

    def __init__(self, sources, maxlen=LOG_BUFFER_MAX):
        self.sources = sources  # list of FileTail
        self.maxlen = maxlen
        self._buf = []
        self._clients = {}
        self._lock = threading.Lock()

    def _cap(self):
        if len(self._buf) > self.maxlen:
            self._buf = self._buf[-self.maxlen:]

    def broadcast(self, item):
        with self._lock:
            self._buf.append(item)
            self._cap()
            clients = list(self._clients.values())
        for q in clients:
            try:
                q.put_nowait(item)
            except queue.Full:
                try:  # slow client: drop its oldest, keep the new
                    q.get_nowait()
                    q.put_nowait(item)
                except Exception:
                    pass

    def add_client_seeded(self, n):
        """Register a client and, under the same lock, snapshot the last n
        buffered lines. No gap and no overlap with subsequent broadcasts."""
        q = queue.Queue(maxsize=1000)
        cid = uuid.uuid4().hex
        with self._lock:
            self._clients[cid] = q
            seed = list(self._buf[-n:]) if n > 0 else []
        return cid, q, seed

    def remove_client(self, cid):
        with self._lock:
            self._clients.pop(cid, None)


TAILER = None  # populated in main()


# --------------------------------------------------------------------------
# Status proxy (2 s cache + explicit down/auth states)
# --------------------------------------------------------------------------
class StatusProxy:
    """Caches /status for STATUS_CACHE_TTL seconds. Returns a dict:
      {"ok": True,  "payload": {...reduced json...}}
      {"ok": False, "payload": {"code": "engine_down" | "auth", "detail": str}}

    Uses http.client (Host-first, no Accept-Encoding) — validated reliable
    against this engine (60/60 HTTP 200 in testing). The engine has been
    observed to return a sporadic one-off 401 while perfectly healthy, so a
    401/403 is retried once after 1 s; only two consecutive 401/403s are
    surfaced as an "auth" (SPLASH_API_KEY mismatch) state. A single transient
    401 costs one poll cycle and shows nothing.

    The browser never receives the key; it travels only in the backend's
    outgoing request to the engine.
    """

    def __init__(self, host=ENGINE_HOST, port=ENGINE_PORT, path=ENGINE_PATH):
        self.host = host
        self.port = port
        self.path = path
        self._cache = None      # (fetched_at, ok, payload)
        self._lock = threading.Lock()

    def _request_once(self):
        conn = http.client.HTTPConnection(self.host, self.port,
                                          timeout=ENGINE_TIMEOUT)
        try:
            conn.putrequest("GET", self.path)
            conn.putheader("Authorization", "Bearer " + API_KEY)
            conn.putheader("Accept", "application/json")
            conn.endheaders()
            resp = conn.getresponse()
            return resp.status, resp.read()
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def fetch(self):
        with self._lock:
            if self._cache is not None:
                fetched_at, ok, payload = self._cache
                if time.time() - fetched_at < STATUS_CACHE_TTL:
                    return dict(ok=ok, payload=payload)
            if not API_KEY:
                payload = {"code": "auth",
                           "detail": "SPLASH_API_KEY is not set in the "
                                     "dashboard backend environment"}
                self._cache = (time.time(), False, payload)
                return dict(ok=False, payload=payload)
            last = None
            for attempt in (0, 1):
                try:
                    code, body = self._request_once()
                except Exception as e:
                    # connection refused / timeout / reset -> engine down
                    last = {"code": "engine_down",
                            "detail": "engine unreachable: %s"
                                      % type(e).__name__}
                    if attempt == 0:
                        time.sleep(0.5)
                    continue
                if code == 200:
                    try:
                        data = json.loads(body)
                    except Exception as e:
                        last = {"code": "engine_down",
                                "detail": "non-JSON /status body (%s)"
                                          % type(e).__name__}
                        break
                    self._cache = (time.time(), True, self.reduce(data))
                    return dict(ok=True, payload=self._cache[2])
                if code in (401, 403):
                    last = {"code": "auth",
                            "detail": "engine /status returned HTTP %d "
                                      "(retried once)" % code}
                    if attempt == 0:
                        time.sleep(1.0)  # tolerate the known one-off 401
                    continue
                last = {"code": "engine_down",
                        "detail": "engine /status returned HTTP %d" % code}
                break
            self._cache = (time.time(), False, last)
            return dict(ok=False, payload=last)

    @staticmethod
    def reduce(data):
        """Trim identity.* noise (keep build_id) and other v1-ignored blobs
        while keeping every panel-relevant field."""
        out = dict(data)
        identity = data.get("identity") or {}
        cache = identity.get("cache") or {}
        out["identity"] = {"cache": {"build_id": cache.get("build_id")},
                           "stripped": True}
        out.pop("http", None)
        out.pop("images", None)
        out["populated_by"] = "splash-dash proxy"
        return out


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "splash-dash/1.1"
    protocol_version = "HTTP/1.1"
    PROXY = None
    TAILER = None

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_static(self, rel):
        path = os.path.join(STATIC_DIR, os.path.basename(rel))
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            self._send_json({"error": "static file missing"}, 500)
            return
        ctype = "text/html; charset=utf-8"
        if path.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        elif path.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            self._send_static("index.html")
        elif u.path == "/app.js":
            self._send_static("app.js")
        elif u.path == "/api/status":
            try:
                res = self.PROXY.fetch()
            except Exception as e:  # defensive: proxy must not crash
                res = {"ok": False,
                       "payload": {"code": "engine_down",
                                   "detail": "proxy error: %s" % e}}
            res["ts"] = time.time()
            self._send_json(res)
        elif u.path == "/api/log":
            self._sse(parse_qs(u.query))
        else:
            self._send_json({"error": "not found"}, 404)

    def _sse(self, query):
        q = query.get("since", ["tail:200"])[0]
        try:
            n = max(0, int(q[5:] if q.lower().startswith("tail:") else q))
        except ValueError:
            n = 200
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        cid = None
        try:
            self._sse_write({"type": "open", "ts": time.time()})
            cid, q_, seed = self.TAILER.add_client_seeded(n)
            for item in seed:
                self._sse_write(item)
            while True:
                try:
                    item = q_.get(timeout=15)
                except queue.Empty:
                    self._sse_write({"type": "ping", "ts": time.time()})
                    continue
                self._sse_write(item)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            if cid is not None:
                self.TAILER.remove_client(cid)

    def _sse_write(self, item):
        etype = item.get("type", "log")
        self.wfile.write(b"event: " + etype.encode() + b"\n")
        self.wfile.write(b"data: " + json.dumps(item, ensure_ascii=False).encode("utf-8")
                         + b"\n\n")
        self.wfile.flush()


# --------------------------------------------------------------------------
# Log reader thread
# --------------------------------------------------------------------------
def start_tailer():
    tails = [FileTail("out", LOG_OUT), FileTail("err", LOG_ERR)]
    tailer = LogBroadcaster(tails)
    # Seed: last 500 lines of the live out file + last 100 of the live err
    # file, then follow from the end.
    for ft in tails:
        live = ft.resolve_live(require_content=False) or ft.base
        for ln in FileTail.read_last_n(live, 500 if ft.name == "out" else 100):
            tailer.broadcast({"type": "log", "file": ft.name, "line": ln,
                              "ts": time.time()})
        ft.open(live, from_end=True)

    def run():
        while True:
            for ft in tails:
                try:
                    lines, events = ft.read_new()
                except Exception as e:  # a tailer bug must not kill the stream
                    sys.stderr.write("[dash] tailer error on %s: %r\n"
                                     % (ft.name, e))
                    lines, events = [], []
                for ev in events:
                    if ev[0] == "truncated":
                        tailer.broadcast({"type": "rotation", "file": ft.name,
                                          "truncated": True, "ts": time.time()})
                    elif ev[0] == "reopened":
                        _, old, new = ev
                        tailer.broadcast({"type": "rotation", "file": ft.name,
                                          "from": old, "to": new,
                                          "ts": time.time()})
                for ln in lines:
                    tailer.broadcast({"type": "log", "file": ft.name,
                                      "line": ln, "ts": time.time()})
            time.sleep(TAIL_TICK)

    t = threading.Thread(target=run, daemon=True, name="log-tailer")
    t.start()
    return tailer


def main():
    ap = argparse.ArgumentParser(description="Splash engine dashboard backend")
    ap.add_argument("--port", type=int, default=BIND_PORT)
    ap.add_argument("--host", default=BIND_HOST,
                    help="bind address (default 127.0.0.1 — localhost only; "
                         "keep it that way, the engine key is proxied here)")
    ap.add_argument("--engine-host", default=ENGINE_HOST)
    ap.add_argument("--engine-port", type=int, default=ENGINE_PORT)
    args = ap.parse_args()
    Handler.PROXY = StatusProxy(host=args.engine_host, port=args.engine_port)
    Handler.TAILER = start_tailer()
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    sys.stderr.write(
        "[dash] splash-dash listening on http://%s:%d "
        "(engine %s:%d%s, key %s)\n" %
        (args.host, args.port, args.engine_host, args.engine_port,
         ENGINE_PATH, "loaded from $SPLASH_API_KEY" if API_KEY else "MISSING"))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
