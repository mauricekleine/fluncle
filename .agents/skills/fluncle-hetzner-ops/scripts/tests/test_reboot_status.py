import http.client
import importlib.util
import json
import os
import platform
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import HTTPServer
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "reboot-status.py"
SPEC = importlib.util.spec_from_file_location("reboot_status", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RebootStatusTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.marker = Path(self.temp.name) / "private-marker"
        self.server = HTTPServer(("127.0.0.1", 0), MODULE.StatusHandler)
        self.server.marker = self.marker
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method="GET", path="/status"):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        connection.request(method, path)
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_missing_marker_returns_only_the_three_public_fields(self):
        status, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(set(body), {"kernel", "reboot_required_age_seconds", "uptime_seconds"})
        self.assertIsNone(body["reboot_required_age_seconds"])
        self.assertEqual(body["kernel"], platform.release())
        self.assertIsInstance(body["uptime_seconds"], int)
        self.assertGreaterEqual(body["uptime_seconds"], 0)

    def test_old_private_marker_reports_age_without_changing_it(self):
        self.marker.write_text("private fixture")
        old = time.time() - 8 * 86400
        os.utime(self.marker, (old, old))
        status, body = self.request()
        self.assertEqual(status, 200)
        self.assertGreaterEqual(body["reboot_required_age_seconds"], 8 * 86400)
        self.assertLess(body["reboot_required_age_seconds"], 8 * 86400 + 5)
        self.assertEqual(self.marker.read_text(), "private fixture")
        self.assertEqual(self.marker.stat().st_mtime, old)

    def test_future_marker_never_reports_negative_age(self):
        self.marker.touch()
        future = time.time() + 3600
        os.utime(self.marker, (future, future))
        self.assertEqual(self.request()[1]["reboot_required_age_seconds"], 0)

    def test_invalid_marker_returns_unavailable_instead_of_recovered(self):
        self.marker.mkdir()
        self.assertEqual(self.request(), (503, {"error": "status unavailable"}))

    def test_paths_and_query_strings_cannot_select_files(self):
        self.marker.write_text("private fixture")
        for path in ("/", "/status?marker=/etc/passwd", "/etc/passwd", "/../status"):
            with self.subTest(path=path):
                self.assertEqual(self.request(path=path), (404, {"error": "not found"}))

    def test_write_methods_cannot_mutate_marker(self):
        self.marker.write_text("private fixture")
        for method in ("POST", "PUT", "PATCH", "DELETE", "CONNECT"):
            with self.subTest(method=method):
                self.assertEqual(self.request(method=method), (501, {"error": "unsupported request"}))
                self.assertEqual(self.marker.read_text(), "private fixture")

    def test_process_rejects_unsafe_bind_or_privileged_port(self):
        for bind, port in (("0.0.0.0", "8080"), ("127.0.0.1", "8080"), ("8.8.8.8", "8080"), ("100.64.0.1", "22")):
            with self.subTest(bind=bind, port=port):
                result = subprocess.run(["python3", str(SCRIPT)], env={**os.environ, "REBOOT_STATUS_BIND": bind, "REBOOT_STATUS_PORT": port}, capture_output=True, text=True, timeout=3)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("tailnet address and unprivileged port required", result.stderr)


if __name__ == "__main__":
    unittest.main()
