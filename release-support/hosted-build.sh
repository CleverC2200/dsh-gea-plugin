#!/usr/bin/env bash
set -euo pipefail
out="$GITHUB_WORKSPACE/outputs"
candidate="$GITHUB_WORKSPACE/candidate"
gea="$candidate/dsh-gea-plugin"
workbench="$candidate/dsh-agent-workbench"
manage="$candidate/dsh-agent-manage"
core="$GITHUB_WORKSPACE/official-latest-standard"
core_head=17746ac35c8fa08e2da98f2127b05f421132cb16
source="$GITHUB_WORKSPACE/source/official-core"

mkdir -p "$out"
cd "$gea"
corepack enable
cp "$RUNNER_TEMP/hosted-sdk-capacity.json" "$out/hosted-sdk-capacity.json"
test "$(git -C "$core" rev-parse HEAD)" = "$core_head"

jq -n --arg root "$candidate" --arg core "$core_head" --arg workbench "$(git -C "$workbench" rev-parse HEAD)" --arg manage "$(git -C "$manage" rev-parse HEAD)" --arg gea "$(git -C "$gea" rev-parse HEAD)" '
 {task:"mps-shipment-weight-0.1.180",core:$core,repositories:[
  {repo:"dsh-agent-workbench",path:($root+"/dsh-agent-workbench"),head:$workbench},
  {repo:"dsh-agent-manage",path:($root+"/dsh-agent-manage"),head:$manage},
  {repo:"dsh-gea-plugin",path:($root+"/dsh-gea-plugin"),head:$gea}
 ]}' > "$out/source.json"

for repo in dsh-agent-manage dsh-agent-workbench dsh-gea-plugin; do
  printf "Preparing %s\n" "$repo"
  node scripts/plugin-split-development.mjs prepare --input "$out/source.json" --repo "$repo" 2>&1 | tee "$out/prepare-$repo.log"
done
for repo in dsh-agent-manage dsh-agent-workbench dsh-gea-plugin; do
  target=plugin
  if [[ "$repo" == dsh-agent-workbench ]]; then target=all; fi
  node scripts/plugin-split-development.mjs build --input "$out/source.json" --repo "$repo" --target "$target" 2>&1 | tee "$out/build-$repo.log"
done

npm install --prefix "$RUNNER_TEMP/packing-pnpm" --ignore-scripts --no-package-lock --no-audit --no-fund pnpm@11.7.0
pnpm="$RUNNER_TEMP/packing-pnpm/node_modules/pnpm/bin/pnpm.mjs"
test -r "$pnpm"
jq --arg core "$core" --arg pnpm "$pnpm" '
  {core:{path:$core,head:.core,version:"0.2.0-rc.2"},pnpm:$pnpm,
   versions:{"@cleverc2200/dsh-agent-workbench":"0.1.180","dsh-agent-manage":"0.6.3-company.92","@cleverc2200/gea-dsh-prototype":"0.0.372","@changfenhuang/dsh-genui":"0.16.0-company.1","dsh-better-sidebar":"0.24.1"},
   repositories:[.repositories[] | .buildReceipt=(.path+"/.runtime/development/build-"+(if .repo=="dsh-agent-workbench" then "all" else "plugin" end)+".json")] }
' "$out/source.json" > "$out/raw-package-input.json"
for repo in dsh-agent-workbench dsh-agent-manage; do
  node scripts/pack-raw.mjs --input "$out/raw-package-input.json" --repo "$repo" --destination "$out/raw-$repo" > "$out/raw-$repo.json"
done
jq --slurpfile wb "$out/raw-dsh-agent-workbench.json" --slurpfile mg "$out/raw-dsh-agent-manage.json" '
 .repositories |= map(if .repo=="dsh-agent-workbench" then .archive=$wb[0].artifact elif .repo=="dsh-agent-manage" then .archive=$mg[0].artifact else . end)
' "$out/raw-package-input.json" > "$out/official-request.json"
runtime="$GITHUB_WORKSPACE/delivery-runtime"
mkdir "$runtime"
cp scripts/delivery-runtime/{package.json,pnpm-lock.yaml} "$runtime/"
(cd "$runtime" && corepack pnpm install --frozen-lockfile --ignore-scripts --prefer-offline)
node scripts/plugin-split-development.mjs deliver --input "$out/official-request.json" --destination "$out/official-delivery" --tool-head "$(git rev-parse HEAD)" --runtime "$runtime"

support="$GITHUB_WORKSPACE/build-task/release-support"
cp "$support"/{baseline.py,prepare-official.mjs,prepare-channels.mjs,desktop-core-environment.json,desktop-2026*.json} "$out/"
python3 "$out/baseline.py" "$out/deployed-baseline"
jq -e --slurpfile sources "$out/source.json" '[.sources[]|. as $main | $sources[0].repositories[]|select(.repo==$main.repo)|.head==$main.head] | length==3 and all(.[])' "$out/deployed-baseline/baseline.json" >/dev/null
jq '[.repositories[]|{key:.repo,value:.head}]|from_entries' "$out/source.json" >"$out/release-main-heads.json"
cp "$out/release-main-heads.json" "$out/observed-main-heads.json"
node "$out/prepare-official.mjs"
node "$out/prepare-channels.mjs" official-release deployed-baseline channels-ready

mkdir "$out/release-proof"
for repo in dsh-agent-manage dsh-agent-workbench dsh-gea-plugin; do
  cp "$candidate/$repo"/.runtime/development/build-*.json "$out/release-proof/$repo-build.json"
done
(cd "$out/release-suite/packages" && shasum -a 256 *.tgz > "$out/release-proof/SHA256SUMS")
