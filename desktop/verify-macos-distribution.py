#!/usr/bin/env python3
"""Read-only release gate. Local launch success is not distribution approval."""
import argparse
import json
from pathlib import Path
import subprocess
import sys


def check(label, command):
    result = subprocess.run(command, capture_output=True, text=True)
    return {"check": label, "ok": result.returncode == 0,
            "detail": (result.stdout + result.stderr).strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    args = parser.parse_args()
    app = args.app.resolve()
    if sys.platform != "darwin" or not app.is_dir() or app.suffix != ".app":
        parser.error("Run on macOS with an existing .app directory")
    results = [check("bundle_signature", ["codesign", "--verify", "--deep", "--strict", str(app)])]
    identity = check("developer_id", ["codesign", "-dv", "--verbose=4", str(app)])
    identity["ok"] = identity["ok"] and "Authority=Developer ID Application:" in identity["detail"]
    results.append(identity)
    # Nested native addons outside standard framework locations also need verification.
    for addon in sorted(app.rglob("*.node")):
        if addon.is_symlink():
            continue
        kind = subprocess.run(["file", "-b", str(addon)], capture_output=True, text=True)
        if "Mach-O" not in kind.stdout:
            continue
        signed = check(str(addon.relative_to(app)), ["codesign", "--verify", "--strict", str(addon)])
        details = check("identity", ["codesign", "-dv", "--verbose=4", str(addon)])
        signed["ok"] = signed["ok"] and details["ok"] and "Authority=Developer ID Application:" in details["detail"]
        if not signed["ok"]:
            signed["detail"] += "\n" + details["detail"]
        results.append(signed)
    results.append(check("notarization_ticket", ["xcrun", "stapler", "validate", str(app)]))
    results.append(check("gatekeeper", ["spctl", "--assess", "--type", "execute", "--verbose=2", str(app)]))
    ok = all(row["ok"] for row in results)
    print(json.dumps({"app": str(app), "distributionReady": ok, "checks": results}, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
