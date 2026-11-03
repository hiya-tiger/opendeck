#!/usr/bin/env bash
# Fills packaging/linux/stage from a release build: stage.sh <cargo target/release dir>
set -eu
T="$1"; D="$(dirname "$0")"; S="$D/stage"; R="$D/../.."
rm -rf "$S"; mkdir -p "$S"
cp "$T/opendecks" "$T/od-bench" "$S/"; [ -f "$T/od-stems-bench" ] && cp "$T/od-stems-bench" "$S/" || true
sed 's/^Exec=opendeck %U/Exec=opendecks %U/' "$R/packaging/io.opendeck.OpenDecks.desktop" > "$S/io.opendeck.OpenDecks.desktop"
cp "$R/packaging/io.opendeck.OpenDecks.metainfo.xml" "$S/"
ICON=$(ls "$R"/rust/crates/opendeck-app/icons/256x256.png 2>/dev/null || true); cp "${ICON:-$R/screenshots/icon.png}" "$S/icon.png"
cp "$R/LICENSE" "$S/"; cp "$R/linux/THIRD-PARTY.md" "$S/"
echo staged; ls -la "$S"
