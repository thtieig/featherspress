#!/usr/bin/env bash
# Installs the Node version named in .nvmrc (latest release of that major,
# linux-x64) into a directory, checked against nodejs.org's SHA256 list.
# Doesn't touch the system Node. Run it again to update; it does nothing when
# that version is already installed.
#
#   tools/install-node.sh                 # into .node/ in the repo (git-ignored)
#   sudo tools/install-node.sh /opt/node  # on a server
#   export PATH="$PWD/.node/bin:$PATH"    # use the local one in this shell
#
# NODE_DIST overrides the download base (default https://nodejs.org/dist).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
# -s: keep a symlinked target (old /opt/node layouts) as the path to replace.
TARGET=$(realpath -ms "${1:-$REPO/.node}")

MAJOR=$(tr -dc '0-9' < "$REPO/.nvmrc")
[ -n "$MAJOR" ] || { echo ".nvmrc has no major version" >&2; exit 1; }
BASE="${NODE_DIST:-https://nodejs.org/dist}/latest-v${MAJOR}.x"

SUMS=$(curl -fsSL "$BASE/SHASUMS256.txt")
FILE=$(echo "$SUMS" | awk '/linux-x64\.tar\.xz$/ {print $2}')
[ -n "$FILE" ] || { echo "No linux-x64 build listed at $BASE" >&2; exit 1; }
VERSION=${FILE#node-}; VERSION=${VERSION%-linux-x64.tar.xz}

if [ -x "$TARGET/bin/node" ] && [ "$("$TARGET/bin/node" -v)" = "$VERSION" ]; then
	echo "Node $VERSION already in $TARGET"
	exit 0
fi

# Unpack beside the target (same filesystem), so the final swap is a quick rename.
mkdir -p "$(dirname "$TARGET")"
TMP=$(mktemp -d "$(dirname "$TARGET")/.install-node.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
echo "Downloading $FILE"
curl -fsSL "$BASE/$FILE" -o "$TMP/$FILE"
(cd "$TMP" && echo "$SUMS" | grep " $FILE\$" | sha256sum -c --quiet -)
# --no-same-owner: as root, don't hand the files to the tarball's build uid.
tar -xJf "$TMP/$FILE" -C "$TMP" --no-same-owner
rm -rf "$TARGET" && mv "$TMP/${FILE%.tar.xz}" "$TARGET"
echo "Node $("$TARGET/bin/node" -v), npm $("$TARGET/bin/npm" -v) in $TARGET"
