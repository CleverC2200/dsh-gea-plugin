#!/usr/bin/env bash
set -euo pipefail
umask 077
out="$GITHUB_WORKSPACE/outputs"
suite="$GITHUB_WORKSPACE/verified-suite"
core="$GITHUB_WORKSPACE/official-latest-standard"
(cd "$suite/release-suite/packages" && shasum -a 256 -c ../../release-proof/SHA256SUMS) | tee "$out/reception-package-integrity.txt"
test "$(git -C "$core" rev-parse HEAD)" = 17746ac35c8fa08e2da98f2127b05f421132cb16
node scripts/runtime-environment.mjs --core "$core" --purpose reception
npm install --prefix "$RUNNER_TEMP/packing-pnpm" --ignore-scripts --no-package-lock --no-audit --no-fund pnpm@11.7.0
pnpm="$RUNNER_TEMP/packing-pnpm/node_modules/pnpm/bin/pnpm.mjs"
node scripts/plugin-reception.mjs --manifest "$suite/release-suite/manifest.json" --core "$core" --pnpm "$pnpm" --home "$out/reception-home" --evidence "$out/reception" 2>&1 | tee "$out/reception.log"
jq -e '.success and .status=="installed-and-host-observed"' "$out/reception/result.json"
