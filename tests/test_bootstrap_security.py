"""Local tests for notebook output handling; no Colab runtime is used."""
import contextlib
import importlib.util
import io
import json
import unittest
from unittest import mock
from types import SimpleNamespace
from pathlib import Path

path = Path(__file__).resolve().parents[1] / "tools" / "colab-bootstrap-probe.py"
spec = importlib.util.spec_from_file_location("bootstrap_probe", path)
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


class FinalNotebookTests(unittest.TestCase):
    def test_final_notebook_supports_headless_bootstrap_without_saved_outputs(self):
        notebook_path = path.parent.parent / "Unified_MOSS_Anima_Colab_Studio_Tailscale_Final.ipynb"
        notebook = json.loads(notebook_path.read_text(encoding="utf-8"))
        cells = bootstrap.load_cells(notebook_path)
        for index in (2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 25):
            self.assertTrue(cells[index].strip(), f"missing bootstrap cell {index}")
        self.assertEqual(cells[4].count('USE_DRIVE = True # @param {type:"boolean"}'), 1)
        self.assertIn("RESTART_HUNG_COMFY = False", cells[8])
        for cell in notebook["cells"]:
            if cell["cell_type"] == "code":
                self.assertEqual(cell.get("outputs", []), [])
                self.assertIsNone(cell.get("execution_count"))


class FakeSocket:
    def __init__(self, error=False):
        self.error = error
        self.messages = []
        self.timeout = 10

    def send(self, data):
        msg_id = json.loads(data)["header"]["msg_id"]
        def reply(kind, content, parent=msg_id):
            return json.dumps({"parent_header": {"msg_id": parent},
                               "header": {"msg_type": kind}, "content": content})
        if self.error:
            self.messages = [reply("error", {"ename": "Error", "traceback": ["secret-trace"]})]
        else:
            self.messages = [reply("execute_reply", {"status": "ok"}),
                             reply("stream", {"text": "secret-state"}),
                             reply("stream", {"text": "other-message"}, "different")]

    def recv(self):
        if self.messages:
            return self.messages.pop(0)
        raise TimeoutError()

    def gettimeout(self):
        return self.timeout

    def settimeout(self, value):
        self.timeout = value


class BootstrapOutputTests(unittest.TestCase):
    def test_state_paths_cannot_escape_state_directory(self):
        for path in ("../secret", "certs/../../secret", "certs/..\\secret", "certs/C:secret"):
            self.assertFalse(bootstrap.valid_state_path(path))
        self.assertTrue(bootstrap.valid_state_path("tailscaled.state"))
        self.assertTrue(bootstrap.valid_state_path("certs/node.crt"))

    def test_late_state_output_is_captured_but_never_echoed(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            ok, _, output = bootstrap.execute_live(FakeSocket(), "session", "pass", echo=False)
        self.assertTrue(ok)
        self.assertEqual(output, "secret-state")
        self.assertEqual(stdout.getvalue(), "")

    def test_bootstrap_runs_selected_cells_for_existing_runtime(self):
        class KernelResponse:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self): return b'{"id":"kernel"}'

        socket = FakeSocket()
        socket.close = lambda: None
        args = SimpleNamespace(cells="0", timeout=10, no_state=True, stub=False,
                               fetch_images=False)
        calls = []
        def execute(ws, session, code, **kwargs):
            calls.append(code)
            return True, "ok", "COMFY 200" if code == bootstrap.VERIFY else ""

        with mock.patch.object(bootstrap.probe, "parse_proxy", return_value=("host", 8080, "suffix", "token")), \
             mock.patch.object(bootstrap.probe, "discover_scheme", return_value=("https", 200, "", "")), \
             mock.patch.object(bootstrap.probe, "wait_for_kernel", return_value=True), \
             mock.patch.object(bootstrap.probe, "ws_connect", return_value=(socket, "session")), \
             mock.patch.object(bootstrap.urllib.request, "urlopen", return_value=KernelResponse()), \
             mock.patch.object(bootstrap, "env_preamble", return_value=("env", [])), \
             mock.patch.object(bootstrap, "execute_live", side_effect=execute), \
             contextlib.redirect_stdout(io.StringIO()):
            result = bootstrap.bootstrap_runtime(args, ["selected cell"], "runtimes/test", {"connectionInfo": {}})
        self.assertEqual(result, 0)
        self.assertIn("selected cell", calls)

    def test_traceback_is_not_echoed_in_silent_mode(self):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            ok, _, output = bootstrap.execute_live(FakeSocket(error=True), "session", "pass", echo=False)
        self.assertFalse(ok)
        self.assertEqual(output, "secret-trace")
        self.assertEqual(stdout.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
