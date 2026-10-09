"""Reconstruct only a fixed diagnostic EXE into a new file, verifying both hashes."""
import base64
import gzip
import hashlib
import json
import pathlib
import sys

base_path, patch_path, output_path = map(pathlib.Path, sys.argv[1:])
base = base_path.read_bytes()
patch = json.loads(gzip.decompress(patch_path.read_bytes()))
assert patch['schema'] == 1
assert hashlib.sha256(base).hexdigest() == patch['baseSha256']
offset, length = patch['offset'], patch['length']
assert 0 <= offset <= len(base) and 0 <= length <= len(base) - offset
target = base64.b64decode(patch['prefix'], validate=True) + base[offset:offset+length] + base64.b64decode(patch['suffix'], validate=True)
assert hashlib.sha256(target).hexdigest() == patch['targetSha256']
with output_path.open('xb') as output:
    output.write(target)
print(json.dumps({'sha256': patch['targetSha256'], 'bytes': len(target)}))
