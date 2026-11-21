import hashlib
import importlib.util
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

path = Path(__file__).resolve().parents[1] / "tools" / "civitai-checkpoint.py"
spec = importlib.util.spec_from_file_location("civitai_checkpoint", path)
civitai = importlib.util.module_from_spec(spec)
spec.loader.exec_module(civitai)


def selection():
    return {"version": {"id": 45, "family": "anima", "baseModel": "Anima", "files": [{"id": 67, "name": "model.safetensors", "sizeKB": 1, "sha256": hashlib.sha256(b"abc").hexdigest()}]}, "fileId": 67, "token": "private-token"}


class FakeResponse:
    def __init__(self, status, body=b"", location=None): self.status_code, self.body, self.headers = status, body, ({"Location": location} if location else {"Content-Type": "application/octet-stream"})
    def close(self): pass
    def raise_for_status(self):
        if self.status_code >= 400: raise RuntimeError("HTTP error")
    def iter_content(self, _size): yield self.body


class FakeSafe:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def keys(self): return ["weight"]


class CivitaiCheckpointTests(unittest.TestCase):
    def test_download_validates_hash_and_does_not_send_token_to_redirect(self):
        calls = []
        def get(url, **kwargs):
            calls.append((url, kwargs["headers"]))
            if len(calls) == 1: return FakeResponse(302, location="https://b2.civitai.com/file/checkpoint")
            return FakeResponse(200, b"abc")
        fake = types.SimpleNamespace(safe_open=lambda *args, **kwargs: FakeSafe())
        with tempfile.TemporaryDirectory() as directory, mock.patch("requests.get", side_effect=get), mock.patch.dict("sys.modules", {"safetensors": fake}), mock.patch.dict("os.environ", {}, clear=False):
            exec(civitai.build_download_cell(selection()), {"MODELS": Path(directory)})
            self.assertEqual((Path(directory) / "diffusion_models" / "civitai-45-67.safetensors").read_bytes(), b"abc")
            self.assertEqual(calls[0][1], {"Authorization": "Bearer private-token"})
            self.assertEqual(calls[1][1], {})

    def test_reuses_verified_drive_checkpoint_without_network(self):
        fake = types.SimpleNamespace(safe_open=lambda *args, **kwargs: FakeSafe())
        with tempfile.TemporaryDirectory() as directory, mock.patch("requests.get", side_effect=AssertionError("unexpected download")), mock.patch.dict("sys.modules", {"safetensors": fake}), mock.patch.dict("os.environ", {}, clear=False):
            root = Path(directory); dest = root / "diffusion_models" / "civitai-45-67.safetensors"
            dest.parent.mkdir(); dest.write_bytes(b"abc")
            exec(civitai.build_download_cell(selection()), {"MODELS": root})
            self.assertEqual(dest.read_bytes(), b"abc")

    def test_hash_mismatch_removes_partial_file(self):
        fake = types.SimpleNamespace(safe_open=lambda *args, **kwargs: FakeSafe())
        with tempfile.TemporaryDirectory() as directory, mock.patch("requests.get", return_value=FakeResponse(200, b"bad")), mock.patch.dict("sys.modules", {"safetensors": fake}):
            with self.assertRaises(RuntimeError): exec(civitai.build_download_cell(selection()), {"MODELS": Path(directory)})
            self.assertEqual(list((Path(directory) / "diffusion_models").iterdir()), [])

    def test_invalid_family_or_file_rejected(self):
        bad = selection(); bad["version"]["family"] = "moss"
        with self.assertRaises(ValueError): civitai.build_download_cell(bad)
        bad = selection(); bad["version"]["files"][0]["name"] = "../../evil.safetensors"
        with self.assertRaises(ValueError): civitai.build_download_cell(bad)

if __name__ == "__main__": unittest.main()
