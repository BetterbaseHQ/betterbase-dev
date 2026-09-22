#!/usr/bin/env bash
# Release pinning: reproducible platform releases (AUD-058).
#
# A platform release is defined by release.toml: every component repo at an
# exact commit. `pin` stamps current HEADs; `check` verifies a checkout
# matches the pin. Run `check` as the release gate before tagging/deploying.
#
# The orchestration repo (betterbase-dev) is deliberately not pinned: the
# commit that contains release.toml IS the release commit.
set -euo pipefail
cd "$(dirname "$0")/.."

RELEASE_FILE="release.toml"
COMPONENTS=(betterbase betterbase-accounts betterbase-sync betterbase-inference betterbase-examples json-joy-rs)

usage() {
    echo "Usage: $0 pin    — stamp current component HEADs into $RELEASE_FILE"
    echo "       $0 check  — verify HEADs + clean trees match $RELEASE_FILE"
    exit 1
}

pinned_rev() {
    grep -E "^$1 = " "$RELEASE_FILE" | sed 's/.*"\(.*\)".*/\1/'
}

cmd="${1:-}"
case "$cmd" in
    pin)
        for repo in "${COMPONENTS[@]}"; do
            if [ -n "$(git -C "$repo" status --porcelain)" ]; then
                echo "Error: $repo has uncommitted changes — commit them before pinning a release." >&2
                exit 1
            fi
        done
        {
            echo "# Betterbase platform release pin."
            echo "#"
            echo "# Written by \`scripts/release.sh pin\` (\`just release-pin\`). A platform"
            echo "# release is this file plus every component at the pinned commit."
            echo "# Verify with \`just check-release\` before tagging or deploying."
            echo "#"
            echo "# The betterbase-dev commit containing this file is the release commit."
            echo ""
            echo "[components]"
            for repo in "${COMPONENTS[@]}"; do
                printf '%s = "%s"\n' "$repo" "$(git -C "$repo" rev-parse HEAD)"
            done
        } > "$RELEASE_FILE"
        echo "Pinned ${#COMPONENTS[@]} components in $RELEASE_FILE:"
        grep -E '^\w' "$RELEASE_FILE" | grep '='
        ;;
    check)
        if [ ! -f "$RELEASE_FILE" ]; then
            echo "Error: $RELEASE_FILE not found — run \`just release-pin\` first." >&2
            exit 1
        fi
        failed=0
        for repo in "${COMPONENTS[@]}"; do
            pinned="$(pinned_rev "$repo")"
            if [ -z "$pinned" ]; then
                echo "MISS  $repo: no pin in $RELEASE_FILE"
                failed=1
                continue
            fi
            head="$(git -C "$repo" rev-parse HEAD)"
            dirty="$(git -C "$repo" status --porcelain)"
            if [ "$head" != "$pinned" ]; then
                echo "MISS  $repo: HEAD ${head:0:12} != pin ${pinned:0:12}"
                failed=1
            elif [ -n "$dirty" ]; then
                echo "MISS  $repo: pinned but has uncommitted changes (incl. untracked)"
                failed=1
            else
                echo "OK    $repo @ ${head:0:12}"
            fi
        done
        if [ "$failed" -ne 0 ]; then
            echo "Release check FAILED — HEADs do not match $RELEASE_FILE." >&2
            exit 1
        fi
        echo "Release check passed: all components at pinned commits."
        ;;
    *)
        usage
        ;;
esac
