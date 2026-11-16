import base64
import copy
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO_ROOT, "htls_editor.py")
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

import htls_editor  # noqa: E402


HANZI_RE = re.compile(r"[\u4e00-\u9fff]")


def _assert_no_hanzi(tc, text):
    tc.assertNotRegex(text, HANZI_RE)


def _run_cli(*args, env=None):
    e = os.environ.copy()
    if env:
        e.update(env)
    return subprocess.run(
        [sys.executable, SCRIPT, *args],
        capture_output=True,
        text=True,
        env=e,
        cwd=REPO_ROOT,
        timeout=60,
    )


def _server_url(srv):
    host, port = srv.server_address
    return "http://{}:{}".format(host, port)


def _request(url, method="GET", headers=None, data=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as exc:
        with exc:
            return exc.code, dict(exc.headers), exc.read()


class _TempDirTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name


class TestCodecAndCore(_TempDirTest):

    def test_demo_parse_validate_serialize_roundtrip(self):
        out = os.path.join(self.dir, "demo.save")
        htls_editor.create_demo_save(out, version="1_0")
        self.assertTrue(os.path.isfile(out))

        with open(out, "rb") as f:
            raw = f.read()
        save = htls_editor.parse_save(out)
        self.assertIsInstance(save, dict)
        htls_editor.validate_save(save)

        save2 = htls_editor.parse_save_bytes(raw)
        self.assertIsInstance(save2, dict)

        out_raw = htls_editor.serialize_save(save)
        self.assertIsInstance(out_raw, (bytes, bytearray))
        save3 = htls_editor.parse_save_bytes(out_raw)
        self.assertIsInstance(save3, dict)

    def test_presets_and_apply_preset(self):
        out = os.path.join(self.dir, "demo.save")
        htls_editor.create_demo_save(out)
        save = htls_editor.parse_save(out)
        self.assertTrue(htls_editor.PRESETS)
        names = list(htls_editor.PRESETS.keys())
        self.assertTrue(names)
        for name in names:
            cloned = copy.deepcopy(save)
            htls_editor.apply_preset(cloned, name)
            htls_editor.validate_save(cloned)

    def test_sync_header(self):
        out = os.path.join(self.dir, "demo.save")
        htls_editor.create_demo_save(out)
        save = htls_editor.parse_save(out)
        htls_editor.sync_header(save)
        htls_editor.validate_save(save)

    def test_secure_path_rejects_traversal_and_bad_names(self):
        good = os.path.join(self.dir, "demo.save")
        self.assertTrue(htls_editor.secure_path(good, must_exist=False))
        bad = [
            os.path.join(self.dir, "demo.txt"),
            os.path.join(self.dir, "CON.save"),
            os.path.join(self.dir, "NUL.save"),
            os.path.join(self.dir, "foo.save:ads"),
            "\\\\server\\share\\a.save",
        ]
        for p in bad:
            with self.assertRaises(htls_editor.SaveError):
                htls_editor.secure_path(p, must_exist=False)

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink not supported")
    def test_secure_path_rejects_symlink(self):
        target = os.path.join(self.dir, "real.save")
        with open(target, "wb") as f:
            f.write(b"x")
        link = os.path.join(self.dir, "link.save")
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(str(exc))
        with self.assertRaises(htls_editor.SaveError):
            htls_editor.secure_path(link, must_exist=False)

    def test_game_running_guard(self):
        out = os.path.join(self.dir, "demo.save")
        htls_editor.create_demo_save(out)
        old = os.environ.get("HTLS_SIMULATE_GAME_RUNNING")
        os.environ["HTLS_SIMULATE_GAME_RUNNING"] = "1"
        try:
            with self.assertRaises(htls_editor.SaveError):
                htls_editor.check_game_running()
            with self.assertRaises(htls_editor.SaveError):
                htls_editor.backup_and_write(out, b"x")
            with self.assertRaises(SystemExit) as cm:
                htls_editor.main(["edit", out, "--money", "10"])
            self.assertNotEqual(cm.exception.code, 0)
        finally:
            if old is None:
                os.environ.pop("HTLS_SIMULATE_GAME_RUNNING", None)
            else:
                os.environ["HTLS_SIMULATE_GAME_RUNNING"] = old

    @unittest.skipUnless(hasattr(os, "symlink"), "symlink not supported")
    def test_backup_and_write_ignores_predictable_tmp_symlink(self):
        demo_path = os.path.join(self.dir, "demo.save")
        htls_editor.create_demo_save(demo_path)
        with open(demo_path, "rb") as f:
            orig_bytes = f.read()

        victim = os.path.join(self.dir, "victim.txt")
        with open(victim, "wb") as f:
            f.write(b"KEEP_ME")
        predictable_tmp = demo_path + ".tmp"
        try:
            os.symlink(victim, predictable_tmp)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(str(exc))

        save = htls_editor.parse_save(demo_path)
        htls_editor.apply_preset(save, "rich_hero")
        new_bytes = htls_editor.serialize_save(save)
        bak_path = htls_editor.backup_and_write(demo_path, new_bytes)

        self.assertTrue(bak_path and os.path.isfile(bak_path))
        with open(victim, "rb") as f:
            self.assertEqual(f.read(), b"KEEP_ME")
        self.assertTrue(os.path.islink(predictable_tmp))
        with open(demo_path, "rb") as f:
            self.assertEqual(f.read(), new_bytes)
        with open(bak_path, "rb") as f:
            self.assertEqual(f.read(), orig_bytes)


class TestCLI(_TempDirTest):

    def test_demo_cli(self):
        out = os.path.join(self.dir, "demo.save")
        r = _run_cli("demo", out, "--version", "1_1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.isfile(out))
        _assert_no_hanzi(self, r.stdout)

    def test_inspect_validate_presets_cli(self):
        out = os.path.join(self.dir, "demo.save")
        r = _run_cli("demo", out)
        self.assertEqual(r.returncode, 0, r.stderr)

        r = _run_cli("inspect", out)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(r.stdout.strip())
        _assert_no_hanzi(self, r.stdout)

        r = _run_cli("validate", out)
        self.assertEqual(r.returncode, 0, r.stderr)
        _assert_no_hanzi(self, r.stdout)

        r = _run_cli("presets")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(r.stdout.strip())
        _assert_no_hanzi(self, r.stdout)

    def test_edit_cli(self):
        out = os.path.join(self.dir, "demo.save")
        r = _run_cli("demo", out)
        self.assertEqual(r.returncode, 0, r.stderr)

        edited = os.path.join(self.dir, "edited.save")
        r = _run_cli("edit", out, "--money", "12345", "--level", "7", "--out", edited)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.isfile(edited))
        _assert_no_hanzi(self, r.stdout)

        save = htls_editor.parse_save(edited)
        htls_editor.validate_save(save)

    def test_edit_cli_preset(self):
        out = os.path.join(self.dir, "demo.save")
        r = _run_cli("demo", out)
        self.assertEqual(r.returncode, 0, r.stderr)
        presets = list(htls_editor.PRESETS.keys())
        self.assertTrue(presets)
        name = presets[0]
        edited = os.path.join(self.dir, "preset.save")
        r = _run_cli("edit", out, "--preset", name, "--out", edited)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        self.assertTrue(os.path.isfile(edited))
        htls_editor.validate_save(htls_editor.parse_save(edited))

    def test_edit_cli_game_running_guard(self):
        out = os.path.join(self.dir, "demo.save")
        r = _run_cli("demo", out)
        self.assertEqual(r.returncode, 0, r.stderr)
        r = _run_cli("edit", out, "--money", "10", env={"HTLS_SIMULATE_GAME_RUNNING": "1"})
        self.assertNotEqual(r.returncode, 0)


class TestHTTP(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        self.token = secrets.token_hex(16)

        handler = htls_editor.ApiHandler
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.srv.root = self.root
        self.srv.token = self.token
        self.thread = threading.Thread(target=self.srv.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop_server)
        self.base = _server_url(self.srv)

        self.demo_path = os.path.join(self.root, "demo.save")
        htls_editor.create_demo_save(self.demo_path)
        with open(self.demo_path, "rb") as f:
            self.raw = f.read()

    def _stop_server(self):
        try:
            self.srv.shutdown()
        finally:
            self.srv.server_close()
            self.thread.join(timeout=5)

    def test_api_info(self):
        status, headers, body = _request(self.base + "/api/info")
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertTrue(data.get("ok"))
        self.assertIn("token", data)
        self.assertEqual(data["token"], self.token)
        self.assertIn("saves", data)
        self.assertIsInstance(data["saves"], list)
        self.assertIn("demo.save", data["saves"])

    def test_api_info_bad_origin_rejected(self):
        status, _, _ = _request(self.base + "/api/info", headers={"Origin": "https://evil.com"})
        self.assertEqual(status, 403)

    def test_api_info_bad_host_rejected(self):
        status, _, _ = _request(self.base + "/api/info", headers={"Host": "evil.com:8080"})
        self.assertEqual(status, 403)

    def test_api_info_bad_sec_fetch_site_rejected(self):
        status, _, _ = _request(self.base + "/api/info", headers={"Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 403)

    def test_get_root_with_html_present(self):
        html_name = "HoTuLoShuSaveEditor-v1.0.html"
        src = os.path.join(REPO_ROOT, "dist", html_name)
        if not os.path.isfile(src):
            self.skipTest("dist editor html not present")
        os.makedirs(os.path.join(self.root, "dist"), exist_ok=True)
        shutil.copyfile(src, os.path.join(self.root, htls_editor.HTML_DEFAULT))
        status, headers, body = _request(self.base + "/")
        self.assertEqual(status, 200)
        self.assertTrue(body)
        ctype = headers.get("Content-Type", "")
        self.assertIn("text/html", ctype.lower())

    def test_api_load(self):
        status, headers, body = _request(self.base + "/api/load?name=demo.save")
        self.assertEqual(status, 200, body[:200])
        self.assertEqual(body, self.raw)
        self.assertIn("application/octet-stream", headers.get("Content-Type", ""))

    def test_api_load_traversal_rejected(self):
        status, _, _ = _request(self.base + "/api/load?name=..%2Fdemo.save")
        self.assertEqual(status, 400)

    def test_api_save_success(self):
        payload_save = htls_editor.parse_save(self.demo_path)
        htls_editor.apply_preset(payload_save, "rich_hero")
        raw = htls_editor.serialize_save(payload_save)
        b64 = base64.b64encode(raw).decode("ascii")
        body = json.dumps({"name": "demo.save", "data": b64}).encode("utf-8")
        status, headers, resp = _request(
            self.base + "/api/save",
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-HTLS-Token": self.token,
                "Origin": self.base,
            },
            data=body,
        )
        self.assertEqual(status, 200, resp[:300])
        data = json.loads(resp.decode("utf-8"))
        self.assertTrue(data.get("ok"))
        self.assertIn("backupPath", data)
        self.assertTrue(os.path.isfile(self.demo_path))
        self.assertTrue(any(n.endswith(".bak") for n in os.listdir(self.root)))

    def test_api_save_wrong_token(self):
        body = json.dumps({"name": "demo.save", "data": "AAAA"}).encode("utf-8")
        status, _, _ = _request(
            self.base + "/api/save",
            method="POST",
            headers={"Content-Type": "application/json", "X-HTLS-Token": "wrong"},
            data=body,
        )
        self.assertEqual(status, 401)

    def test_api_save_missing_token(self):
        body = json.dumps({"name": "demo.save", "data": "AAAA"}).encode("utf-8")
        status, _, _ = _request(
            self.base + "/api/save",
            method="POST",
            headers={"Content-Type": "application/json"},
            data=body,
        )
        self.assertEqual(status, 401)

    def test_api_save_wrong_content_type(self):
        body = json.dumps({"name": "demo.save", "data": "AAAA"}).encode("utf-8")
        status, _, _ = _request(
            self.base + "/api/save",
            method="POST",
            headers={"Content-Type": "text/plain", "X-HTLS-Token": self.token},
            data=body,
        )
        self.assertEqual(status, 415)

    def test_api_save_bad_origin(self):
        body = json.dumps({"name": "demo.save", "data": "AAAA"}).encode("utf-8")
        status, _, _ = _request(
            self.base + "/api/save",
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-HTLS-Token": self.token,
                "Origin": "https://evil.com",
            },
            data=body,
        )
        self.assertEqual(status, 403)

    def test_api_save_game_running_guard(self):
        payload_save = htls_editor.parse_save(self.demo_path)
        raw = htls_editor.serialize_save(payload_save)
        b64 = base64.b64encode(raw).decode("ascii")
        body = json.dumps({"name": "demo.save", "data": b64}).encode("utf-8")
        old = os.environ.get("HTLS_SIMULATE_GAME_RUNNING")
        os.environ["HTLS_SIMULATE_GAME_RUNNING"] = "1"
        try:
            status, _, resp = _request(
                self.base + "/api/save",
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "X-HTLS-Token": self.token,
                    "Origin": self.base,
                },
                data=body,
            )
            self.assertEqual(status, 400)
            data = json.loads(resp.decode("utf-8"))
            self.assertFalse(data.get("ok", False))
            self.assertIn("오류", data)
        finally:
            if old is None:
                os.environ.pop("HTLS_SIMULATE_GAME_RUNNING", None)
            else:
                os.environ["HTLS_SIMULATE_GAME_RUNNING"] = old


class TestRealSaveIfPresent(unittest.TestCase):
    REAL_DIR = "/tmp/htls_saves_ro"

    def setUp(self):
        if not os.path.isdir(self.REAL_DIR):
            self.skipTest("/tmp/htls_saves_ro not present")
        names = sorted(n for n in os.listdir(self.REAL_DIR) if n.endswith(".save"))
        if not names:
            self.skipTest("no .save files in /tmp/htls_saves_ro")
        self.name = "Manual020.save" if "Manual020.save" in names else names[0]
        self.path = os.path.join(self.REAL_DIR, self.name)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tmpdir = self.tmp.name

    def test_parse_validate_serialize_roundtrip_in_memory(self):
        with open(self.path, "rb") as f:
            raw = f.read()
        before = raw
        save = htls_editor.parse_save_bytes(raw)
        self.assertIsInstance(save, dict)
        htls_editor.validate_save(save)
        out = htls_editor.serialize_save(save)
        self.assertIsInstance(out, (bytes, bytearray))
        save2 = htls_editor.parse_save_bytes(out)
        htls_editor.validate_save(save2)
        with open(self.path, "rb") as f:
            after = f.read()
        self.assertEqual(before, after)

    def test_cmd_edit_to_temp_out_lossless(self):
        out = os.path.join(self.tmpdir, "edited.save")
        r = _run_cli("edit", self.path, "--out", out)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.isfile(out))
        htls_editor.validate_save(htls_editor.parse_save(out))
        _assert_no_hanzi(self, r.stdout)


if __name__ == "__main__":
    unittest.main()
