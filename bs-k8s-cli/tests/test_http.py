from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import requests

from bs_k8s.client import ApiError, Client, K8sError, encode_password


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body, headers=None, content_type="application/json"):
        data = body.encode() if isinstance(body, str) else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        self.server.seen.append(("POST", self.path, self.headers.get("Cookie"), data))
        if data.get("encrypt") == encode_password("kubesphere", "test-password"):
            self.reply(302, "", {"Location": "/", "Set-Cookie": "token=test-session; Path=/; HttpOnly"})
        else:
            self.reply(401, {"message": "secret-in-error-body"})

    def do_GET(self):
        self.server.seen.append(("GET", self.path, self.headers.get("Cookie"), None))
        if self.path == "/redirect":
            self.reply(302, "", {"Location": "http://external.invalid/credential-sink"})
        elif self.path == "/html":
            self.reply(200, "secret-in-html", content_type="text/html")
        elif self.path == "/forbidden":
            self.reply(403, {"message": "secret-in-error-body"})
        elif self.path == "/readyz":
            self.reply(200, "ok", content_type="text/plain")
        elif self.path == "/api/v1/pods?limit=500":
            self.reply(200, {"kind": "PodList", "metadata": {"continue": "next"}, "items": [{"metadata": {"name": "one"}}]})
        elif self.path == "/api/v1/pods?limit=500&continue=next":
            self.reply(200, {"kind": "PodList", "metadata": {}, "items": [{"metadata": {"name": "two"}}]})
        elif self.path == "/apis":
            self.reply(200, "console-app", content_type="text/html")
        elif self.path == "/apis/":
            self.reply(200, {"groups": [{"preferredVersion": {"groupVersion": "apps/v1"}}, {"preferredVersion": {"groupVersion": "broken/v1"}}]})
        elif self.path == "/api/v1":
            self.reply(200, {"resources": [{"name": "pods", "kind": "Pod", "namespaced": True, "shortNames": ["po"]}, {"name": "pods/log", "kind": "Pod", "namespaced": True}]})
        elif self.path == "/apis/apps/v1":
            self.reply(200, {"resources": [{"name": "deployments", "kind": "Deployment", "namespaced": True}]})
        elif self.path == "/apis/broken/v1":
            self.reply(503, {"message": "aggregated API down"})
        else:
            token = self.headers.get("Cookie", "")
            auth = self.headers.get("Authorization", "")
            self.reply(200 if "token=test-session" in token or auth == "Bearer native-test-token" else 401, {"ok": True})


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.server.seen = []
        self.cfg = Path(self.tmp.name) / "config.json"

    def client(self, **overrides):
        return Client({"url": self.url, "username": "test-user", "password": "test-password", **overrides}, config=self.cfg)

    def test_console_login_uses_encoded_payload_and_cookie(self):
        client = self.client()
        self.assertEqual(client.request("GET", "/version"), {"ok": True})
        login, get = self.server.seen
        self.assertEqual(login[1], "/login")
        self.assertNotIn("password", login[3])
        self.assertNotIn("test-password", json.dumps(login[3]))
        self.assertIn("token=test-session", get[2])

    def test_cache_reused_by_next_process_client(self):
        self.client().request("GET", "/version")
        self.client().request("GET", "/version")
        self.assertEqual(len([x for x in self.server.seen if x[0] == "POST"]), 1)
        for cache in (self.cfg.parent / "sessions").glob("*.json"):
            self.assertEqual(cache.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("test-password", cache.read_text())

    def test_bad_password_does_not_print_body_or_reuse_old_cookie(self):
        client = self.client()
        client.request("GET", "/version")
        client.profile["password"] = "bad-password"
        with self.assertRaises(K8sError) as raised:
            client.login(force=True)
        self.assertNotIn("secret", str(raised.exception))
        self.assertNotIn("bad-password", str(raised.exception))

    def test_native_token_from_environment(self):
        with patch.dict(os.environ, {"TEST_NATIVE_TOKEN": "native-test-token"}):
            client = self.client(mode="kubernetes", token_env="TEST_NATIVE_TOKEN")
            self.assertEqual(client.request("GET", "/version"), {"ok": True})
        self.assertEqual(len([x for x in self.server.seen if x[0] == "POST"]), 0)

    def test_redirect_never_followed(self):
        with self.assertRaises(K8sError):
            self.client().request("GET", "/redirect")
        self.assertEqual([x[1] for x in self.server.seen], ["/login", "/redirect"])

    def test_html_not_accepted_as_json(self):
        with self.assertRaises(K8sError) as raised:
            self.client().request("GET", "/html")
        self.assertNotIn("secret-in-html", str(raised.exception))

    def test_forbidden_error_suppresses_raw_body(self):
        with self.assertRaises(ApiError) as raised:
            self.client().request("GET", "/forbidden")
        self.assertEqual(raised.exception.status, 403)
        self.assertNotIn("secret-in-error-body", str(raised.exception))

    def test_list_fetches_all_pages(self):
        result = self.client().list("/api/v1/pods")
        self.assertEqual([x["metadata"]["name"] for x in result["items"]], ["one", "two"])

    def test_discovery_skips_unavailable_aggregated_api_and_subresources(self):
        client = self.client()
        self.assertEqual(client.resolve("po")["name"], "pods")
        self.assertEqual(client.resolve("deploy")["apiVersion"], "apps/v1")
        self.assertEqual(len(client.discover()), 2)

    def test_network_error_does_not_retry_or_print_exception_payload(self):
        client = self.client(mode="kubernetes", token="native-test-token")
        with patch.object(client.session, "request", side_effect=requests.ConnectionError("secret-in-network-error")) as request:
            with self.assertRaises(K8sError) as raised:
                client.request("PATCH", "/api/v1/pods/test", body={})
        self.assertEqual(request.call_count, 1)
        self.assertNotIn("secret-in-network-error", str(raised.exception))

    def test_path_validation_blocks_credential_exfiltration(self):
        client = self.client(mode="kubernetes", token="native-test-token")
        for path in ("//external.invalid/api", "http://external.invalid/", "/api/../login", "/api\\foo"):
            with self.subTest(path=path), self.assertRaises(K8sError):
                client.request("GET", path)
        self.assertEqual(self.server.seen, [])

    def test_tls_verification_cannot_be_disabled(self):
        with self.assertRaises(K8sError):
            self.client(verify_tls=False)

    def test_native_health_endpoint_accepts_plain_text(self):
        client = self.client(mode="kubernetes", token="native-test-token")
        self.assertEqual(client.request("GET", "/readyz", text=True), "ok")


if __name__ == "__main__":
    unittest.main()
