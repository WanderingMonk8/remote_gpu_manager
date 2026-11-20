import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock

path = Path(__file__).resolve().parents[1] / "tools" / "drive-cache.py"
spec = importlib.util.spec_from_file_location("drive_cache", path)
drive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drive)
files = [{"id": "id1", "name": "moss_image_sft_int8_convrot.safetensors"},
         {"id": "id2", "name": "qwen3.5_9b_w4a8_gptq.safetensors"},
         {"id": "id3", "name": "flux2-vae_small.safetensors"}]


class Response:
    def __init__(self, name): self.name = name
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def raise_for_status(self): pass
    def json(self): return {"name": self.name, "size": "3", "md5Checksum": hashlib.md5(b"abc").hexdigest()}
    def iter_content(self, _size): yield b"abc"


class DriveCacheTests(unittest.TestCase):
    def test_requires_complete_safe_selection(self):
        with self.assertRaises(ValueError): drive.build_restore_cell("token", files[:2])
        with self.assertRaises(ValueError): drive.build_restore_cell("token", files + [{"id":"../bad", "name":"bad"}])

    def test_restores_only_verified_files(self):
        by_id = {f["id"]: f["name"] for f in files}
        def get(url, **kwargs): return Response(by_id[url.rsplit("/", 1)[-1]])
        with tempfile.TemporaryDirectory() as directory, mock.patch("requests.get", side_effect=get):
            root = Path(directory)
            exec(drive.build_restore_cell("token", files), {"MODELS": root})
            for file in files:
                self.assertEqual((root / drive.FILES[file["name"]] / file["name"]).read_bytes(), b"abc")

    def test_corrupt_download_never_becomes_a_model(self):
        class Corrupt(Response):
            def iter_content(self, _size): yield b"bad"
        by_id = {f["id"]: f["name"] for f in files}
        with tempfile.TemporaryDirectory() as directory, mock.patch("requests.get", side_effect=lambda url, **kw: Corrupt(by_id[url.rsplit("/", 1)[-1]])):
            root = Path(directory)
            with self.assertRaises(RuntimeError): exec(drive.build_restore_cell("token", files), {"MODELS": root})
            dest = root / drive.FILES[files[0]["name"]] / files[0]["name"]
            self.assertFalse(dest.exists())
            self.assertFalse(dest.with_suffix(dest.suffix + ".part").exists())


if __name__ == "__main__": unittest.main()
