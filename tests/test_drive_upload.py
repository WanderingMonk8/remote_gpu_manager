import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('drive_upload', Path(__file__).resolve().parents[1] / 'tools' / 'drive-upload.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class DriveUploadTests(unittest.TestCase):
    def test_upload_verifies_file_before_returning_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'model.safetensors'
            path.write_bytes(b'abc')
            init = Mock(headers={'Location': 'https://www.googleapis.com/upload/drive/v3/files?upload_id=secret'})
            done = Mock(status_code=200)
            done.json.return_value = {'id': 'id1', 'name': path.name, 'size': '3', 'md5Checksum': hashlib.md5(b'abc').hexdigest()}
            session = Mock(post=Mock(return_value=init), put=Mock(return_value=done))
            self.assertEqual(module.upload_cache(path, lambda: 'token', session=session), {'id': 'id1', 'name': path.name})
            done.json.return_value['md5Checksum'] = 'bad'
            with self.assertRaises(ValueError): module.upload_cache(path, lambda: 'token', session=session)

    def test_rejects_untrusted_upload_location(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'model.safetensors'
            path.write_bytes(b'abc')
            session = Mock(post=Mock(return_value=Mock(headers={'Location': 'https://evil.example/upload/drive/v3/files'})))
            with self.assertRaises(ValueError): module.upload_cache(path, lambda: 'token', session=session)
            session.put.assert_not_called()

if __name__ == '__main__': unittest.main()
