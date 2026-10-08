#!/usr/bin/env python3
import ipaddress
import json
import os
import platform
import stat
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


class StatusHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, format, *args):
        pass

    def reply(self, status, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response_only(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_error(self, code, message=None, explain=None):
        self.reply(code, {"error": "unsupported request"})

    def do_GET(self):
        if self.path != "/status":
            self.reply(404, {"error": "not found"})
            return
        try:
            marker = self.server.marker.stat()
            if not stat.S_ISREG(marker.st_mode):
                raise OSError("invalid marker")
            age = max(0, int(time.time() - marker.st_mtime))
        except FileNotFoundError:
            age = None
        except OSError:
            self.reply(503, {"error": "status unavailable"})
            return
        self.reply(200, {
            "reboot_required_age_seconds": age,
            "kernel": platform.release(),
            "uptime_seconds": int(time.clock_gettime(
                getattr(time, "CLOCK_BOOTTIME", time.CLOCK_MONOTONIC))),
        })


def main():
    try:
        bind = ipaddress.IPv4Address(os.environ["REBOOT_STATUS_BIND"])
        port = int(os.environ["REBOOT_STATUS_PORT"])
        if bind not in ipaddress.IPv4Network("100.64.0.0/10") or not 1024 <= port <= 65535:
            raise ValueError("tailnet address and unprivileged port required")
    except (KeyError, ValueError) as error:
        raise SystemExit(f"invalid reboot status configuration: {error}") from error
    server = HTTPServer((str(bind), port), StatusHandler)
    server.marker = Path(os.environ.get("REBOOT_STATUS_MARKER", "/var/run/reboot-required"))
    server.serve_forever()


if __name__ == "__main__":
    main()
