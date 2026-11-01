#!/usr/bin/env bash
# Install or upgrade XQ Squad in a git checkout. Used by reusable GitHub Actions.
set -euo pipefail

TARGET="${1:-.}"
VERSION="${2:-}"
SQUAD_REPO="${XQ_SQUAD_REPO:-ExperienceQuality/xq-squad}"
ASSUME_YES="${XQ_SQUAD_ASSUME_YES:-true}"

usage() {
  echo "Usage: xq-squad-sync-runner.sh TARGET VERSION (e.g. v1.4.0)" >&2
  exit 2
}

[[ -n "$VERSION" ]] || usage
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Error: VERSION must match vX.Y.Z, got $VERSION" >&2
  exit 1
}

TARGET="$(cd "$TARGET" && pwd)"
[[ -d "$TARGET/.git" ]] || {
  echo "Error: TARGET is not a git repository: $TARGET" >&2
  exit 1
}

yes_flag=""
[[ "$ASSUME_YES" == "true" ]] && yes_flag="--yes"

install_url="https://github.com/${SQUAD_REPO}/releases/download/${VERSION}/install.sh"
update_url="https://github.com/${SQUAD_REPO}/releases/download/${VERSION}/update.sh"

if [[ -f "$TARGET/.squad/install-state.json" ]]; then
  curl -fsSL "$update_url" | sh -s -- --target "$TARGET" --version "$VERSION" --repo "$SQUAD_REPO" $yes_flag
else
  curl -fsSL "$install_url" | sh -s -- --target "$TARGET" --version "$VERSION" --repo "$SQUAD_REPO" $yes_flag
fi
