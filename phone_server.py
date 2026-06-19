#!/usr/bin/env python3
"""Phone/CarPlay-friendly proxy for the local DJ server."""
from __future__ import annotations

import http.client
import http.server
import mimetypes
import urllib.parse
from pathlib import Path

DJ_DIR = Path(__file__).parent / "dj"
TARGET_HOST = "127.0.0.1"
TARGET_PORT = 8765
SKIP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}


class PhoneHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, _fmt, *_args):
        pass

    def do_GET(self):
        self._handle()

    def do_HEAD(self):
        self._handle()

    def _handle(self) -> None:
        url = urllib.parse.urlparse(self.path)
        if url.path in ("/", "/index.html"):
            return self._static("index.html")
        if url.path in ("/car", "/car.html"):
            return self._static("car.html")
        if url.path == "/library.json":
            return self._proxy("/library.json" + (f"?{url.query}" if url.query else ""))
        if url.path.startswith("/media/"):
            parts = [p for p in url.path.split("/") if p]
            track_id = urllib.parse.unquote(parts[1]) if len(parts) >= 2 else ""
            return self._proxy(f"/audio?id={urllib.parse.quote(track_id)}")
        if url.path == "/audio":
            return self._proxy(self.path)
        static_name = url.path.lstrip("/")
        if static_name and "/" not in static_name:
            return self._static(static_name)
        self.send_error(404, "not found")

    def _static(self, rel: str) -> None:
        root = DJ_DIR.resolve()
        path = (root / rel).resolve()
        if not path.is_file() or not path.is_relative_to(root):
            self.send_error(404, "not found")
            return
        data = path.read_bytes()
        ctype, _ = mimetypes.guess_type(str(path))
        ctype = ctype or "application/octet-stream"
        if path.suffix == ".js":
            ctype = "application/javascript"
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _proxy(self, path: str) -> None:
        headers = {
            k: v for k, v in self.headers.items()
            if k.lower() not in SKIP_HEADERS and k.lower() != "host"
        }
        conn = http.client.HTTPConnection(TARGET_HOST, TARGET_PORT, timeout=30)
        try:
            conn.request(self.command, path, headers=headers)
            resp = conn.getresponse()
            self.send_response(resp.status, resp.reason)
            for key, value in resp.getheaders():
                if key.lower() in SKIP_HEADERS:
                    continue
                self.send_header(key, value)
            if path.startswith("/audio"):
                self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command == "HEAD":
                return
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    break
        finally:
            conn.close()


def main() -> None:
    server = http.server.ThreadingHTTPServer(("0.0.0.0", 8768), PhoneHandler)
    print("SCDL CarPlay server: http://172.20.10.2:8768/car.html", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
