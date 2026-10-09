#!/usr/bin/env python3
"""Apply/rollback only the three validated summary model files, with hash checks.

Run on the Cube host after its installed compiler and read-only tests pass.
Backups must be outside the model directory. No restart or permission mutation.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace(source, target):
    stat = target.stat()
    fd, name = tempfile.mkstemp(prefix='.summary-', suffix='.pending', dir=target.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(source.read_bytes())
            f.flush()
            os.fsync(f.fileno())
        os.chmod(name, stat.st_mode & 0o777)
        os.chown(name, stat.st_uid, stat.st_gid)
        os.replace(name, target)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['apply', 'rollback'])
    parser.add_argument('--model-root', type=Path, required=True)
    parser.add_argument('--candidate', type=Path, required=True)
    parser.add_argument('--backup', type=Path, required=True)
    args = parser.parse_args()
    root = args.model_root.resolve()
    backup = args.backup.resolve()
    if backup == root or root in backup.parents:
        raise ValueError('Backup must be outside model scan')
    manifest = json.loads((args.candidate / 'manifest.json').read_text())
    expected_names = {'cubes/' + n + '.yml' for n in (
        'agents_sales_plan_detail_mi', 'agents_scm_inventory_age', 'agents_scm_cust_inventory_daily')}
    if len(manifest) != 3 or {m['fileName'] for m in manifest} != expected_names:
        raise ValueError('Unexpected deployment scope')
    applying = args.action == 'apply'
    for m in manifest:
        target = root / m['fileName']
        if target.is_symlink():
            raise ValueError('Refuse symlink target')
        assert sha(target) == m['originalSha256' if applying else 'candidateSha256'], 'Concurrent model change: ' + str(target)
        source = (args.candidate if applying else backup) / target.name
        assert sha(source) == m['candidateSha256' if applying else 'originalSha256'], 'Unexpected source hash'
    if applying:
        backup.mkdir(mode=0o700, parents=True, exist_ok=False)
        for m in manifest:
            shutil.copy2(root / m['fileName'], backup / Path(m['fileName']).name)
        shutil.copy2(args.candidate / 'manifest.json', backup / 'manifest.json')
    touched = []
    try:
        for m in manifest:
            target = root / m['fileName']
            assert sha(target) == m['originalSha256' if applying else 'candidateSha256'], 'Concurrent model change'
            replace((args.candidate if applying else backup) / target.name, target)
            touched.append(m)
            assert sha(target) == m['candidateSha256' if applying else 'originalSha256']
    except Exception:
        # Restore only files still equal to this operation's output, not another editor's work.
        for m in reversed(touched):
            target = root / m['fileName']
            if sha(target) == m['candidateSha256' if applying else 'originalSha256']:
                replace((backup if applying else args.candidate) / target.name, target)
        raise
    print(json.dumps(dict(action=args.action, files=len(touched), backup=str(backup), hashes={m['fileName']: sha(root / m['fileName']) for m in manifest})))


if __name__ == '__main__':
    main()
