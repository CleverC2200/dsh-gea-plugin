#!/usr/bin/env python3
"""Fetch fixed team skill sources, compare whole trees, and fast-forward safely.
No shell evaluation, credentials, implicit stash, force push or package publication.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

RECEIPT = '.team-skill-install.json'


def git(repo, *args):
    p = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, timeout=60)
    if p.returncode:
        # Do not echo transport diagnostics: remote URLs can contain credentials.
        raise RuntimeError('Git 操作失败或无法联网核验：' + args[0])
    return p.stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def inventory(folder):
    result = {}
    if not folder.exists():
        return result
    if folder.is_symlink():
        raise RuntimeError('技能目录为符号链接，需要人工核对：' + folder.name)
    for p in folder.rglob('*'):
        rel = p.relative_to(folder).as_posix()
        if p.is_symlink():
            raise RuntimeError('技能包含符号链接，需要人工核对：' + rel)
        if p.is_file() and '__pycache__' not in p.parts and p.name not in {RECEIPT, '.DS_Store'}:
            result[rel] = digest(p.read_bytes())
    return result


def local_extra(path):
    return path.startswith('references/local-') and path.endswith('.md')


def remote_for(repo, url):
    matches = [r for r in git(repo, 'remote').decode().splitlines()
               if git(repo, 'remote', 'get-url', r).decode().strip() == url]
    if not matches:
        raise RuntimeError('找不到清单指定 URL 的远端；请核对仓库配置')
    return matches[0]


def fetch(repo, spec):
    remote = remote_for(repo, spec['url'])
    branch = spec['branch']
    if not branch or branch.startswith('-') or any(c in branch for c in ':\n '):
        raise RuntimeError('无效的分支配置')
    ref = 'refs/remotes/' + remote + '/' + branch
    git(repo, 'fetch', '--no-tags', remote, '+refs/heads/' + branch + ':' + ref)
    return git(repo, 'rev-parse', ref).decode().strip()


def source(root, spec):
    repo = Path(os.environ.get(spec.get('checkoutEnv', ''), str(root / spec['repository']))).resolve()
    if not repo.exists():
        raise RuntimeError('缺少技能来源 checkout；设置 ' + spec.get('checkoutEnv', 'repository'))
    sha = fetch(repo, spec)
    prefix = spec['path'].rstrip('/') + '/'
    tree = {}
    for entry in git(repo, 'ls-tree', '-r', '-z', sha, '--', prefix).split(b'\0'):
        if not entry:
            continue
        meta, raw = entry.split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        path = raw.decode()
        rel = path[len(prefix):]
        if not path.startswith(prefix) or '..' in Path(rel).parts or mode not in {'100644', '100755'} or kind != 'blob':
            raise RuntimeError('技能来源有不支持的文件类型/路径')
        tree[rel] = (git(repo, 'cat-file', 'blob', oid), mode)
    if 'SKILL.md' not in tree:
        raise RuntimeError('远端主线尚无此技能；不能以本地草稿宣称最新')
    return sha, tree


def compare(target, tree):
    actual = inventory(target)
    expected = {p: digest(data) for p, (data, mode) in tree.items()}
    changed = sorted(p for p, h in expected.items() if actual.get(p) != h)
    extras = sorted(p for p in actual if p not in expected)
    unexpected = [p for p in extras if not local_extra(p)]
    status = 'missing' if not target.exists() else 'different' if changed or unexpected else 'current_with_local_notes' if extras else 'current'
    return {'status': status, 'changedFiles': changed, 'unexpectedFiles': unexpected,
            'localNotes': [p for p in extras if local_extra(p)]}


def install(target, sha, tree):
    state = compare(target, tree)
    actual = inventory(target)
    receipt = target / RECEIPT
    if target.exists() and state['status'] == 'different':
        if not receipt.exists():
            raise RuntimeError('未受管理的本机技能有差异，先人工合并；未覆盖')
        saved = json.loads(receipt.read_text())['files']
        if any(actual.get(p) != h for p, h in saved.items()) or any(p not in saved and not local_extra(p) for p in actual):
            raise RuntimeError('本机技能存在未同步修改，先人工合并；未覆盖')
    target.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='.' + target.name + '-', dir=target.parent))
    try:
        for rel, (data, mode) in tree.items():
            p = stage / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
            p.chmod(0o755 if mode == '100755' else 0o644)
        for rel in actual:
            if rel not in tree and local_extra(rel):
                p = stage / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target / rel, p)
        (stage / RECEIPT).write_text(json.dumps({'sourceSha': sha, 'files': {p: digest(d) for p, (d, m) in tree.items()}}, indent=2) + '\n')
        backup = None
        if target.exists():
            backup_root = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'backups/team-skills'
            backup_root.mkdir(parents=True, exist_ok=True)
            backup = Path(tempfile.mkdtemp(prefix=target.name + '-', dir=backup_root)) / target.name
            shutil.copytree(target, backup)
            # Same filesystem rename makes replacement atomic to readers.
            previous = stage.with_name(stage.name + '-previous')
            target.rename(previous)
            try:
                stage.rename(target)
            except BaseException:
                previous.rename(target)
                raise
            shutil.rmtree(previous)
        else:
            stage.rename(target)
        return str(backup) if backup else None
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def check(root, config, skills_home, apply=False):
    rows = []
    for spec in config['skills']:
        row = {'name': spec['name']}
        try:
            if Path(spec['name']).name != spec['name'] or spec['name'] in {'.', '..'}:
                raise RuntimeError('无效的技能名称')
            sha, tree = source(root, spec)
            target = skills_home / spec['name']
            row['sourceSha'] = sha
            if apply:
                row['backup'] = install(target, sha, tree)
            row.update(compare(target, tree))
        except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired, KeyError) as e:
            row.update(status='unverified', reason=str(e))
        rows.append(row)
    return rows


def sync(root, config):
    own = next(s for s in config['skills'] if s['repository'] == '.')
    sha = fetch(root, own)
    if git(root, 'branch', '--show-current').decode().strip() != own['branch']:
        raise RuntimeError('sync 只快进主分支；任务分支请显式合并最新主线')
    if git(root, 'status', '--porcelain'):
        raise RuntimeError('工作区有未提交/未跟踪文件；先核对与备份，未自动暂存或覆盖')
    if subprocess.run(['git', '-C', str(root), 'merge-base', '--is-ancestor', 'HEAD', sha], capture_output=True).returncode:
        raise RuntimeError('本地主线有独有提交或已分叉；未覆盖')
    env = dict(os.environ, GEA_TEAM_SYNC_ACTIVE='1')
    p = subprocess.run(['git', '-C', str(root), 'merge', '--ff-only', sha], capture_output=True, env=env)
    if p.returncode:
        raise RuntimeError('快进失败，保留 Git 当前状态供核对')
    return sha


HOOK = '''#!/bin/sh
# gea-team-skills-check-v1
[ "$GEA_TEAM_SYNC_ACTIVE" = "1" ] && exit 0
root=$(git rev-parse --show-toplevel) || exit 0
[ -f "$root/scripts/team-workflow.py" ] || exit 0
python3 "$root/scripts/team-workflow.py" check --repo "$root" || {
  echo '团队技能未核验通过；Git 操作已完成，发布前请运行 team-workflow.py check 并处理差异。' >&2
}
exit 0
'''


def install_hooks(root):
    configured = subprocess.run(['git', '-C', str(root), 'config', '--get', 'core.hooksPath'], capture_output=True)
    if configured.returncode == 0:
        raise RuntimeError('已有 core.hooksPath；请把检查命令接入现有 hook，未覆盖配置')
    common = Path(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir').decode().strip())
    paths = [common / 'hooks' / name for name in ['post-merge', 'post-rewrite']]
    for p in paths:
        if p.is_symlink() or (p.exists() and p.read_text() != HOOK):
            raise RuntimeError('已有 ' + p.name + '，未覆盖；请人工接入检查')
    for p in paths:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(HOOK)
        p.chmod(0o755)
    return [str(p) for p in paths]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['check', 'sync', 'install-skills', 'install-hooks'])
    parser.add_argument('--repo', default='.')
    parser.add_argument('--skills-home', default=str(Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'skills'))
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    root = Path(git(Path(args.repo), 'rev-parse', '--show-toplevel').decode().strip())
    config = json.loads((root / '.team-skills.json').read_text())
    if args.command == 'install-hooks':
        print(json.dumps({'hooks': install_hooks(root)}, ensure_ascii=False, indent=2))
        return 0
    result = {'checkedAt': datetime.now(timezone.utc).isoformat()}
    if args.command == 'sync':
        result['sourceHead'] = sync(root, config)
        # The fast-forward can update the checker itself. Use the new entrypoint,
        # not this already-loaded old Python module, for the post-sync check.
        p = subprocess.run([sys.executable, str(root / 'scripts/team-workflow.py'), 'check', '--repo', str(root), '--skills-home', args.skills_home])
        print(json.dumps(result, ensure_ascii=False))
        return p.returncode
    if args.command == 'install-skills' and not args.apply:
        raise RuntimeError('安装需要 --apply；仅检查请使用 check')
    result['skills'] = check(root, config, Path(args.skills_home), args.command == 'install-skills')
    result['ok'] = all(r['status'] in {'current', 'current_with_local_notes'} for r in result['skills'])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['ok'] else 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired, StopIteration) as error:
        print(json.dumps({'ok': False, 'reason': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(2)
