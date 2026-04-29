#!/usr/bin/env bash
# List open parent (non-sub) issues from GitHub, with labels and open sub-issue counts.
# Usage:
#   scripts/list-issues.sh                # all parent issues
#   scripts/list-issues.sh --label feature
#   scripts/list-issues.sh --label bug
set -euo pipefail

OWNER="eddy-hq"
REPO="eddy"
LABEL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --label)
      LABEL="${2:?--label requires a value}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

gh api graphql -f query='query($o:String!,$r:String!){repository(owner:$o,name:$r){issues(first:100,states:OPEN,orderBy:{field:CREATED_AT,direction:DESC}){nodes{number title parent{number} subIssues(first:50){nodes{number state}} labels(first:10){nodes{name}}}}}}' \
  -F o="$OWNER" -F r="$REPO" \
  | jq -r --arg label "$LABEL" '
      .data.repository.issues.nodes
      | map(select(.parent == null)
            | select($label == "" or any(.labels.nodes[]; .name == $label)))
      | .[]
      | "#\(.number)  \(.title)  [\(.labels.nodes | map(.name) | join(","))]  open-subs:\(.subIssues.nodes | map(select(.state == "OPEN")) | length)"
    '
