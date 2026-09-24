"""Behavior tests against temporary local Git remotes; no production access."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('team_workflow', ROOT / '.agents/skills/gitlab-collaboration/scripts/team_workflow.py')
sys.dont_write_bytecode = True
wf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wf)


class TeamWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {'CODEX_HOME': str(self.root / 'codex')})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.remote = self.root / 'remote'
        self.repo = self.root / 'checkout'
        self.remote.mkdir()
        self.run_git(self.remote, 'init', '-b', 'main')
        self.run_git(self.remote, 'config', 'user.email', 'test@example.invalid')
        self.run_git(self.remote, 'config', 'user.name', 'Test')
        (self.remote / 'skills/demo').mkdir(parents=True)
        (self.remote / 'skills/demo/SKILL.md').write_text('version: 1\nold behavior\n')
        self.commit()
        self.run_git(self.root, 'clone', str(self.remote), str(self.repo))
        self.item = {'name': 'demo', 'repository': '.', 'url': str(self.remote), 'branch': 'main', 'path': 'skills/demo'}
        self.config = {'skills': [self.item]}
        self.target = self.root / 'installed/demo'

    def run_git(self, root, *args):
        return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.DEVNULL)

    def commit(self):
        self.run_git(self.remote, 'add', '.')
        self.run_git(self.remote, 'commit', '-m', 'test')

    def fetched(self):
        return wf.source(self.repo, self.item)

    def install(self):
        sha, tree = self.fetched()
        wf.install(self.target, sha, tree)
        return sha, tree

    def test_same_version_changes_and_script_changes_are_detected(self):
        self.install()
        (self.remote / 'skills/demo/SKILL.md').write_text('version: 1\nnew behavior\n')
        (self.remote / 'skills/demo/check.py').write_text('print(1)\n')
        self.commit()
        sha, tree = self.fetched()
        result = wf.compare(self.target, tree)
        self.assertEqual(result['status'], 'different')
        self.assertEqual(result['changedFiles'], ['SKILL.md', 'check.py'])

    def test_install_updates_managed_files_preserves_private_note_and_backup(self):
        self.install()
        note = self.target / 'references/local-machine.md'
        note.parent.mkdir()
        note.write_text('machine-specific data')
        (self.remote / 'skills/demo/SKILL.md').write_text('version: 2\nnew\n')
        self.commit()
        sha, tree = self.fetched()
        backup = wf.install(self.target, sha, tree)
        self.assertEqual((Path(backup) / 'SKILL.md').read_text(), 'version: 1\nold behavior\n')
        self.assertEqual(note.read_text(), 'machine-specific data')
        self.assertEqual(wf.compare(self.target, tree)['status'], 'current_with_local_notes')

    def test_local_edit_is_not_overwritten(self):
        self.install()
        p = self.target / 'SKILL.md'
        p.write_text('my unfinished change')
        sha, tree = self.fetched()
        with self.assertRaisesRegex(RuntimeError, '未同步修改'):
            wf.install(self.target, sha, tree)
        self.assertEqual(p.read_text(), 'my unfinished change')

    def test_unmanaged_different_installation_is_not_overwritten(self):
        self.target.mkdir(parents=True)
        (self.target / 'SKILL.md').write_text('unknown local work')
        sha, tree = self.fetched()
        with self.assertRaisesRegex(RuntimeError, '未受管理'):
            wf.install(self.target, sha, tree)

    def test_missing_checkout_and_wrong_remote_are_not_current(self):
        bad = dict(self.item, url='file:///not-the-declared-repo')
        rows = wf.check(self.repo, {'skills': [bad]}, self.target.parent)
        self.assertEqual(rows[0]['status'], 'unverified')
        bad = dict(self.item, repository='missing')
        self.assertEqual(wf.check(self.repo, {'skills': [bad]}, self.target.parent)[0]['status'], 'unverified')

    def test_sync_refuses_untracked_or_modified_files(self):
        old = self.run_git(self.repo, 'rev-parse', 'HEAD')
        p = self.repo / 'keep.txt'
        p.write_text('must survive')
        with self.assertRaisesRegex(RuntimeError, '未跟踪'):
            wf.sync(self.repo, self.config)
        self.assertEqual(p.read_text(), 'must survive')
        self.assertEqual(self.run_git(self.repo, 'rev-parse', 'HEAD'), old)

    def test_sync_refuses_local_commits(self):
        self.run_git(self.repo, 'config', 'user.email', 'test@example.invalid')
        self.run_git(self.repo, 'config', 'user.name', 'Test')
        (self.repo / 'keep.txt').write_text('local commit')
        self.run_git(self.repo, 'add', '.')
        self.run_git(self.repo, 'commit', '-m', 'local')
        with self.assertRaisesRegex(RuntimeError, '独有提交'):
            wf.sync(self.repo, self.config)
        self.assertTrue((self.repo / 'keep.txt').exists())

    def test_sync_fast_forwards_and_noop_is_safe(self):
        (self.remote / 'new.txt').write_text('upstream')
        self.commit()
        sha = wf.sync(self.repo, self.config)
        self.assertEqual(self.run_git(self.repo, 'rev-parse', 'HEAD').decode().strip(), sha)
        self.assertEqual(wf.sync(self.repo, self.config), sha)

    def test_hook_install_is_idempotent_and_preserves_other_hooks(self):
        paths = wf.install_hooks(self.repo)
        self.assertEqual(wf.install_hooks(self.repo), paths)
        p = Path(paths[0])
        p.write_text('#!/bin/sh\necho existing\n')
        with self.assertRaisesRegex(RuntimeError, '已有 post-merge'):
            wf.install_hooks(self.repo)
        self.assertEqual(p.read_text(), '#!/bin/sh\necho existing\n')

    def test_hook_detects_changed_skill_after_real_pull(self):
        # A real post-merge executes the new repository entrypoint.
        scripts = self.remote / 'scripts'
        scripts.mkdir()
        (scripts / 'team-workflow.py').write_text('from pathlib import Path\nPath("hook-ran").write_text("checked")\n')
        self.commit()
        wf.install_hooks(self.repo)
        self.run_git(self.repo, 'pull', '--ff-only')
        self.assertEqual((self.repo / 'hook-ran').read_text(), 'checked')

    def test_cli_sync_checks_even_when_main_is_already_current(self):
        (self.remote / '.team-skills.json').write_text(json.dumps(self.config))
        scripts = self.remote / 'scripts'
        scripts.mkdir()
        (scripts / 'team-workflow.py').write_text('print("new-checker-used")\nraise SystemExit(2)\n')
        self.commit()
        self.run_git(self.repo, 'pull', '--ff-only')
        for _ in range(2):
            result = subprocess.run([sys.executable, str(Path(wf.__file__)), 'sync', '--repo', str(self.repo)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('new-checker-used', result.stdout)

    def test_symlink_source_is_rejected(self):
        (self.remote / 'skills/demo/unsafe').symlink_to('/etc/passwd')
        self.commit()
        with self.assertRaisesRegex(RuntimeError, '文件类型'):
            self.fetched()


if __name__ == '__main__':
    unittest.main()
