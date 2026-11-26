#!/usr/bin/env bash
set -euo pipefail
repo='CleverC2200/dsh-agent-workbench'
workbench="$GITHUB_WORKSPACE/candidate/dsh-agent-workbench"
for attempt in $(seq 1 60); do
  record="$(gh api "repos/$repo/pulls/452")"
  jq -e --arg expected "$MPS_CANDIDATE_HEAD" '.head.sha==$expected and .base.ref=="main"' <<< "$record" >/dev/null
  if jq -e '.merged==true and .state=="closed"' <<< "$record" >/dev/null; then
    head="$(jq -er '.merge_commit_sha' <<< "$record")"
    test "$head" = "$(gh api "repos/$repo/git/ref/heads/main" --jq .object.sha)"
    git -C "$workbench" fetch --no-tags origin refs/heads/main
    git -C "$workbench" merge --ff-only "$head"
    test "$(git -C "$workbench" rev-parse HEAD)" = "$head"
    test "$(git -C "$workbench" rev-parse "$head^2")" = "$MPS_CANDIDATE_HEAD"
    exit
  fi
  jq -e '.state=="open"' <<< "$record" >/dev/null
  sleep 10
done
exit 3
