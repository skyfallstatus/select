#!/bin/zsh
# For people working on the panel. Builds it and copies it to your own extensions folder, unsigned.
# Testers don't need this: they get the installer. See docs/PACKAGING.md.
#   scripts/dev-install.sh
# EXTENSIONS_DIR replaces the destination folder, which is how the script is tested.
set -e -o pipefail
cd "${0:A:h}/.."
source ./product.conf
DEST="${EXTENSIONS_DIR:-$HOME/Library/Application Support/Adobe/CEP/extensions}/$BUNDLE_ID"

scripts/build-engine.sh
scripts/build-panel.sh
mkdir -p "$DEST"
rsync -a --delete dist/$BUNDLE_ID/ "$DEST/"
print "installed: $DEST"
print "engine: $("$DEST/bin/$ENGINE" version)"
print
print "This copy is unsigned, so Premiere only loads it with Adobe's debug mode on, for the CEP version your Premiere uses."
print "This script doesn't change that setting. For CEP 12, which Premiere 25 and later use, it's:"
print "    defaults write com.adobe.CSXS.12 PlayerDebugMode 1"
print "Debug mode lets every unsigned extension on this Mac load, so turn it off when you're done:"
print "    defaults delete com.adobe.CSXS.12 PlayerDebugMode"
print "If a signed $NAME is also installed, Premiere loads the higher version, then the newer manifest."
print "Quit and reopen Premiere to pick up a new install. For a change to an existing one, close and reopen the panel."
