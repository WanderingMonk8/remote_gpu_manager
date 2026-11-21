"""Upload a model cache file to Drive without replacing existing files.

The caller supplies a short-lived access token when needed. File IDs are returned
only after Google reports a complete upload and its size and checksum match.
"""
import hashlib
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

import requests

CHUNK = 8 * 1024 * 1024


def upload_cache(path, token_provider, *, session=requests, retries=4):
    path = Path(path)
    if not path.is_file() or not path.name.lower().endswith('.safetensors'):
        raise ValueError('invalid cache file')
    size = path.stat().st_size
    if not size:
        raise ValueError('empty cache file')
    digest = hashlib.md5()
    with path.open('rb') as source:
        while block := source.read(CHUNK):
            digest.update(block)
    headers = {'Authorization': 'Bearer ' + token_provider(),
               'X-Upload-Content-Type': 'application/octet-stream',
               'X-Upload-Content-Length': str(size)}
    init = session.post('https://www.googleapis.com/upload/drive/v3/files',
                        params={'uploadType': 'resumable', 'fields': 'id,name,size,md5Checksum'},
                        headers=headers, json={'name': path.name, 'appProperties': {'rgm_cache': '1'}}, timeout=30)
    init.raise_for_status()
    url = init.headers.get('Location', '')
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or parsed.hostname != 'www.googleapis.com' or not parsed.path.startswith('/upload/drive/v3/files'):
        raise ValueError('invalid upload session')
    offset = 0
    failures = 0
    with path.open('rb') as source:
        while offset < size:
            source.seek(offset)
            chunk = source.read(min(CHUNK, size - offset))
            headers = {'Content-Length': str(len(chunk)),
                       'Content-Range': f'bytes {offset}-{offset + len(chunk) - 1}/{size}',
                       'Authorization': 'Bearer ' + token_provider()}
            try:
                response = session.put(url, headers=headers, data=chunk, timeout=(30, 120), allow_redirects=False)
                if response.status_code in (200, 201):
                    metadata = response.json()
                    if (metadata.get('name') != path.name or str(metadata.get('size')) != str(size)
                            or metadata.get('md5Checksum', '').lower() != digest.hexdigest()):
                        raise ValueError('uploaded cache failed verification')
                    file_id = metadata.get('id')
                    if not isinstance(file_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', file_id):
                        raise ValueError('invalid uploaded file id')
                    return {'id': file_id, 'name': path.name}
                if response.status_code != 308:
                    response.raise_for_status()
                    raise ValueError('unexpected upload response')
                match = re.fullmatch(r'bytes=0-(\d+)', response.headers.get('Range', ''))
                next_offset = int(match.group(1)) + 1 if match else 0
                if next_offset <= offset or next_offset > offset + len(chunk):
                    raise ValueError('invalid upload offset')
                offset = next_offset
                failures = 0
            except (requests.RequestException, OSError):
                failures += 1
                if failures > retries:
                    raise
                time.sleep(min(2 ** failures, 16))
                probe = session.put(url, headers={'Authorization': 'Bearer ' + token_provider(),
                    'Content-Length': '0', 'Content-Range': f'bytes */{size}'}, data=b'', timeout=30, allow_redirects=False)
                if probe.status_code != 308:
                    probe.raise_for_status()
                    raise ValueError('upload completion requires verification')
                match = re.fullmatch(r'bytes=0-(\d+)', probe.headers.get('Range', ''))
                offset = int(match.group(1)) + 1 if match else 0
                if offset < 0 or offset > size:
                    raise ValueError('invalid upload offset')
    raise ValueError('upload ended without verification')
