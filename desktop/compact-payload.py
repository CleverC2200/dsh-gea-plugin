"""Compact a new platform payload copy, preserving runtime code and update archives."""
from pathlib import Path
import argparse, hashlib, json, shutil, subprocess, time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('platform', choices=['mac', 'win'])
parser.add_argument('source', type=Path)
parser.add_argument('destination', type=Path)
args = parser.parse_args()
source = args.source.resolve(strict=True)
subprocess.run(['node', str(Path(__file__).with_name('verify-company-manage.mjs')), str(source)], check=True)
target = args.destination.resolve()
if target.exists() or target.is_relative_to(source) or source.is_relative_to(target):
    raise SystemExit('Use a new destination outside the source payload')
started = time.time()
target.parent.mkdir(parents=True, exist_ok=True)
# APFS clones avoid duplicating blocks during local release preparation.
if subprocess.run(['cp', '-cR', str(source), str(target)], capture_output=True).returncode:
    if target.exists():
        raise SystemExit('Copy failed; inspect the new destination before retrying')
    shutil.copytree(source, target, symlinks=True)
removed = []
platform_arch = 'darwin-arm64' if args.platform == 'mac' else 'win32-x64'

for item in list(target.rglob('*')):
    if not item.is_file() or item.is_symlink():
        continue
    relative = item.relative_to(target)
    parts = relative.parts
    reason = None
    if parts[0] == 'node_modules':
        if item.suffix == '.map':
            reason = 'source-map'
        elif item.suffix == '.pdb':
            reason = 'native-debug-symbols'
        elif 'node-pty' in parts and 'prebuilds' in parts:
            index = parts.index('prebuilds')
            if parts[index + 1] != platform_arch:
                reason = 'other-platform-node-pty-prebuild'
    elif len(parts) > 1 and parts[0] == 'node' and parts[1] in ['include', 'share']:
        reason = 'node-development-headers-or-documentation'
    if reason:
        removed.append({'path': str(relative), 'reason': reason, 'bytes': item.stat().st_size})
        item.unlink()

# node-pty ships a helper whose executable bit can be lost with ignored install scripts.
permission_fixes = []
if args.platform == 'mac':
    for helper in (target / 'node_modules').rglob('spawn-helper'):
        if helper.is_symlink() or not helper.is_file():
            continue
        relative = helper.relative_to(target)
        if 'node-pty' not in relative.parts or platform_arch not in relative.parts:
            continue
        old_mode = helper.stat().st_mode & 0o777
        new_mode = old_mode | 0o111
        if old_mode != new_mode:
            helper.chmod(new_mode)
            permission_fixes.append({'path': str(relative), 'before': oct(old_mode), 'after': oct(new_mode)})

removed_paths = {entry['path'] for entry in removed}
checked = 0
before = after = 0
for original in source.rglob('*'):
    relative = str(original.relative_to(source))
    copy = target / relative
    if original.is_symlink():
        assert copy.is_symlink() and original.readlink() == copy.readlink(), relative
        assert copy.resolve().is_relative_to(target), 'External link: ' + relative
    elif original.is_file():
        before += original.stat().st_size
        if relative in removed_paths:
            assert not copy.exists(), relative
        else:
            assert copy.is_file(), relative
            assert hashlib.sha256(original.read_bytes()).digest() == hashlib.sha256(copy.read_bytes()).digest(), relative
            checked += 1
            after += copy.stat().st_size
by_reason = {}
for entry in removed:
    by_reason[entry['reason']] = by_reason.get(entry['reason'], 0) + entry['bytes']
report = {'platform': args.platform, 'source': str(source), 'target': str(target),
          'beforeBytes': before, 'afterBytes': after, 'removedBytes': before-after,
          'unchangedFilesChecked': checked, 'removedByReason': by_reason, 'permissionFixes': permission_fixes,
          'elapsedSeconds': round(time.time()-started, 2), 'removedFiles': removed}
(target.parent / 'compact-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k != 'removedFiles'}, ensure_ascii=False))
