#!/usr/bin/env bash
set -euo pipefail
repo='CleverC2200/dsh-agent-workbench'
workbench="$GITHUB_WORKSPACE/candidate/dsh-agent-workbench"
gea="$GITHUB_WORKSPACE/candidate/dsh-gea-plugin"
support="$GITHUB_WORKSPACE/build-task/release-support/observed-main-heads.json"
tagged_head(){
  git -C "$1" ls-remote --tags origin "refs/tags/$2^{}" | awk '{print $1}'
}
for attempt in $(seq 1 110); do
  record="$(gh api "repos/$repo/pulls/457")"
  jq -e --arg expected "$MPS_CANDIDATE_HEAD" '.head.sha==$expected and .base.ref=="main"' <<< "$record" >/dev/null
  if jq -e '.merged==true and .state=="closed"' <<< "$record" >/dev/null; then
    head="$(jq -er '.merge_commit_sha' <<< "$record")"
    test "$head" = "$(gh api "repos/$repo/git/ref/heads/main" --jq .object.sha)"
    if [[ "$(tagged_head "$workbench" v0.1.186)" = "$head" ]] && [[ "$(tagged_head "$gea" v0.0.379)" = "$(git -C "$gea" rev-parse HEAD)" ]]; then
      git -C "$workbench" fetch --no-tags origin refs/heads/main
      git -C "$workbench" merge --ff-only "$head"
      test "$(git -C "$workbench" rev-parse HEAD)" = "$head"
      test "$(git -C "$workbench" rev-parse "$head^2")" = "$MPS_CANDIDATE_HEAD"
      jq --arg head "$head" '.["dsh-agent-workbench"]=$head' "$support" > "$support.next"
      mv "$support.next" "$support"
      exit 0
    fi
  else
    jq -e '.state=="open"' <<< "$record" >/dev/null
  fi
  sleep 10
done
exit 3
