#!/usr/bin/env bash
# Render the M4's launchd plists from the committed templates.
#
#   launchd/<label>.plist.template  →  launchd/<label>.plist  (gitignored)
#
# The templates carry placeholders rather than this machine's paths, so the
# repo holds no home directory. Run once after cloning, and again after
# editing a template. The installed server plist is a symlink to the rendered
# file (see docs/ops.md), so rendering is all an edit needs on disk; launchd
# still caches the loaded definition until a bootout/bootstrap.
#
#   NODE_BIN=/path/to/node scripts/render-launchd.sh
#
# NODE_BIN defaults to the node on PATH. Pin it to an absolute path when the
# shell's node differs from the one launchd should run.
set -euo pipefail

EDDY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "node not found — set NODE_BIN to an absolute path." >&2
  exit 1
fi

for template in "$EDDY_DIR"/launchd/*.plist.template; do
  out="${template%.template}"
  sed -e "s|__EDDY_DIR__|${EDDY_DIR}|g" \
      -e "s|__HOME__|${HOME}|g" \
      -e "s|__NODE_BIN__|${NODE_BIN}|g" \
      "$template" > "$out.tmp"
  if grep -q '__[A-Z_]*__' "$out.tmp"; then
    echo "Unrendered placeholder left in $out" >&2
    rm -f "$out.tmp"
    exit 1
  fi
  mv "$out.tmp" "$out"
  echo "Rendered ${out#"$EDDY_DIR"/}"
done
