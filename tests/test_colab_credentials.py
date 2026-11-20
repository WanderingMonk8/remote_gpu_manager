import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

path = Path(__file__).resolve().parents[1] / "tools" / "colab-runtime-api.py"
spec = importlib.util.spec_from_file_location("colab_runtime_api", path)
api = importlib.util.module_from_spec(spec)
spec.loader.exec_module(api)


class CredentialTests(unittest.TestCase):
    def test_consent_preserves_existing_tunnel_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client, creds = root / "client.json", root / "creds.json"
            client.write_text(json.dumps({"installed": {"client_id": "id", "client_secret": "secret"}}))
            creds.write_text(json.dumps({"TS_AUTHKEY": "key", "BASIC_AUTH_USER": "user", "BASIC_AUTH_PASS": "pass"}))
            with mock.patch.object(api, "CLIENT_SECRET", client), mock.patch.object(api, "CREDS_PATH", creds), \
                 mock.patch.object(api, "auth", return_value=SimpleNamespace(refresh_token="new")) as auth, \
                 contextlib.redirect_stdout(io.StringIO()):
                api.cmd_creds(drive_file=True)
            saved = json.loads(creds.read_text())
            self.assertEqual(saved["refresh_token"], "new")
            self.assertEqual(saved["TS_AUTHKEY"], "key")
            self.assertEqual(saved["BASIC_AUTH_PASS"], "pass")
            auth.assert_called_once_with(offline=True, drive_file=True)


if __name__ == "__main__": unittest.main()
