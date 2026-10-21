"""Tar transport for generated files only; the Node caller owns source admission."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile

action, root_arg, manifest_arg, bundle = sys.argv[1:]
root = Path(root_arg)
manifest = json.loads(Path(manifest_arg).read_text())
entries = {entry["path"]: entry for entry in manifest["entries"]}
tracked = {}


def clean_git_output(target):
    for source in manifest["binding"]["manifest"]["repositories"]:
        checkout = root / "candidate" / source["repo"]
        try:
            local = target.relative_to(checkout).as_posix()
        except ValueError:
            continue
        if str(checkout) not in tracked:
            try:
                head = subprocess.check_output(
                    ["git", "-C", str(checkout), "rev-parse", "HEAD"],
                    stderr=subprocess.DEVNULL,
                ).decode().strip()
                if head != source["head"]:
                    return False
                relative_checkout = checkout.relative_to(root)
                roots = sorted({
                    Path(entry["path"]).relative_to(relative_checkout).parts[0]
                    for entry in entries.values()
                    if entry["path"].startswith(relative_checkout.as_posix() + "/")
                })
                rows = subprocess.check_output(
                    ["git", "-C", str(checkout), "ls-tree", "-rz", "HEAD", "--", *roots]
                )
                files = {}
                for row in rows.split(b"\0"):
                    if not row:
                        continue
                    metadata, path = row.split(b"\t", 1)
                    mode, kind, digest = metadata.decode().split()
                    if kind == "blob" and mode in ["100644", "100755"]:
                        files[path.decode()] = (int(mode[-3:], 8), digest)
                tracked[str(checkout)] = files
            except subprocess.CalledProcessError:
                return False
        expected = tracked[str(checkout)].get(local)
        if not expected or target.is_symlink() or not target.is_file():
            return False
        data = target.read_bytes()
        digest = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        return expected == (target.stat().st_mode & 0o777, digest)
    return False


def check_output_parents(target):
    for parent in target.parents:
        if parent == root:
            break
        if parent.is_symlink() or (parent.exists() and not parent.is_dir()):
            raise ValueError("output parent refuses symlink traversal")


def retired_workbench_declarations():
    retired = []
    for source in manifest["binding"]["manifest"]["repositories"]:
        if source["repo"] != "dsh-agent-workbench":
            continue
        checkout = root / "candidate" / source["repo"]
        if not (checkout / ".git").exists():
            continue
        rows = subprocess.check_output([
            "git", "-C", str(checkout), "ls-tree", "-rz", source["head"], "--", "lib/types"
        ])
        for row in rows.split(b"\0"):
            if not row:
                continue
            metadata, path = row.split(b"\t", 1)
            local = path.decode()
            target = checkout / local
            if not metadata.startswith(b"100644 blob ") or not local.endswith(".d.ts"):
                continue
            if target.relative_to(root).as_posix() in entries or not (target.exists() or target.is_symlink()):
                continue
            check_output_parents(target)
            if not clean_git_output(target):
                raise ValueError("retired declaration refuses removal")
            retired.append(target)
    return retired


if action == "export":
    with tarfile.open(bundle, "x") as archive:
        for name in entries:
            archive.add(root / name, arcname=name, recursive=False)
else:
    with tarfile.open(bundle, "r") as archive, tempfile.TemporaryDirectory(prefix=".quality-transport-", dir=root) as temporary:
        members = archive.getmembers()
        if len(members) != len(entries) or {m.name for m in members} != set(entries):
            raise ValueError("archive inventory changed")
        replace = set()
        for member in members:
            entry = entries[member.name]
            if member.mode != entry["mode"]:
                raise ValueError("archive file metadata changed")
            staged = Path(temporary) / member.name
            if entry["type"] == "symlink":
                if not member.issym() or member.linkname != entry["target"]:
                    raise ValueError("archive symlink changed")
                continue
            if not member.isfile() or member.size != entry["size"]:
                raise ValueError("archive file metadata changed")
            staged.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with archive.extractfile(member) as source, staged.open("xb") as output:
                while chunk := source.read(64 * 1024):
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != entry["sha256"]:
                raise ValueError("archive bytes changed")
            os.chmod(staged, member.mode)
        # Finish all archive checks before touching a final output.
        for member in members:
            entry = entries[member.name]
            target = root / member.name
            check_output_parents(target)
            if target.exists() or target.is_symlink():
                if not entry["control"] and entry["type"] == "file" and clean_git_output(target):
                    replace.add(member.name)
                elif (
                    not entry["control"]
                    or target.is_symlink()
                    or not target.is_file()
                    or target.read_bytes() != (Path(temporary) / member.name).read_bytes()
                    or target.stat().st_mode & 0o777 != entry["mode"]
                ):
                    raise ValueError("existing output refuses overwrite")
        retired = retired_workbench_declarations()
        for target in retired:
            if not clean_git_output(target):
                raise ValueError("Git declaration changed before removal")
            target.unlink()
        for member in members:
            entry = entries[member.name]
            target = root / member.name
            if entry["control"] and target.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if entry["type"] == "symlink":
                os.symlink(entry["target"], target)
            elif member.name in replace:
                if not clean_git_output(target):
                    raise ValueError("Git output changed before replacement")
                os.replace(Path(temporary) / member.name, target)
            else:
                # link() publishes without overwriting; the private staging alias is removed on exit.
                os.link(Path(temporary) / member.name, target)
