#!/bin/zsh
# Looks inside a built package without installing it. Expands it to a temp folder and checks what would land on a Mac.
#   scripts/check-pkg.sh <pkg> [--require-signature]
set -e -o pipefail
cd "${0:A:h}/.."
refuse() { print -u2 -- "FAIL $1"; exit 1 }
PKG=${1:?usage: check-pkg.sh <pkg> [--require-signature]}
source ./product.conf
# Relative to the user's home folder, since the package installs there only.
LOCATION="/Library/Application Support/Adobe/CEP/extensions/$BUNDLE_ID"
[[ -f $PKG ]] || refuse "No package at $PKG."

WORK=$(mktemp -d "${TMPDIR:-/tmp}/pkg-check.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
pkgutil --expand "$PKG" $WORK/flat
COMPONENT=$WORK/flat/component.pkg
[[ -f $COMPONENT/Bom && -f $COMPONENT/PackageInfo ]] || refuse "The package has no component inside."
[[ ! -e $COMPONENT/Scripts ]] || refuse "The package carries scripts. It's meant to have none."
grep -q "hostArchitectures=\"arm64,x86_64\"" $WORK/flat/Distribution || refuse "The Distribution would ask Apple silicon for Rosetta."
DOMAINS=$(grep -o '<domains [^>]*>' $WORK/flat/Distribution) || refuse "The Distribution doesn't say where it installs."
[[ $DOMAINS == *'enable_currentUserHome="true"'* && $DOMAINS == *'enable_localSystem="false"'* && $DOMAINS == *'enable_anywhere="false"'* ]] || refuse "The package must install for the current user only, in their home folder: $DOMAINS"
grep -q 'auth="none"' $COMPONENT/PackageInfo || refuse "The package asks for an administrator. It installs in the user's home and needs none."
grep -q "version=\"$VERSION\"" $COMPONENT/PackageInfo || refuse "The package isn't version $VERSION."
grep -qF "install-location=\"$LOCATION\"" $COMPONENT/PackageInfo || refuse "The install location isn't $LOCATION."
grep -q 'relocatable="false"' $COMPONENT/PackageInfo || refuse "The package could be moved somewhere Premiere won't look."

lsbom -p fMUGs $COMPONENT/Bom > $WORK/bom.txt
print "payload: $(wc -l < $WORK/bom.txt | tr -d ' ') entries, $(du -sh "$PKG" | cut -f1 | tr -d ' ')"
grep -v -E "	root	wheel" $WORK/bom.txt > $WORK/odd.txt || true
[[ ! -s $WORK/odd.txt ]] || { cat $WORK/odd.txt; refuse "These entries aren't owned by root."; }
ENGINE_LINE=$(grep -F "./bin/$ENGINE	" $WORK/bom.txt) || refuse "The engine isn't in the payload."
[[ $ENGINE_LINE == *"-rwxr-xr-x"* ]] || refuse "The engine isn't executable: $ENGINE_LINE"
HOST=$(sed -n 's|.*<ScriptPath>\./\(.*\)</ScriptPath>.*|\1|p' panel/CSXS/manifest.xml)
for REQUIRED in CSXS/manifest.xml client/index.html client/update.js $HOST; do
  grep -qF "./$REQUIRED	" $WORK/bom.txt || refuse "$REQUIRED isn't in the payload."
done
if grep -E '/(\.debug|\.DS_Store|test|__MACOSX)(/|	)|/\._|\.test\.js' $WORK/bom.txt; then refuse "Something that must not ship is in the payload."; fi

pkgutil --expand-full "$PKG" $WORK/full
INSIDE="$WORK/full/component.pkg/Payload"
[[ $("$INSIDE/bin/$ENGINE" version) == $VERSION ]] || refuse "The engine in the payload doesn't run."
ARCHS=$(lipo -archs "$INSIDE/bin/$ENGINE")
[[ $ARCHS == *arm64* && $ARCHS == *x86_64* ]] || refuse "The engine in the payload isn't universal: $ARCHS"
codesign --verify "$INSIDE/bin/$ENGINE" 2>/dev/null || refuse "The engine's own signature doesn't verify in the payload."
if grep -rIlF "$HOME" "$INSIDE" "$WORK/flat/Distribution" "$COMPONENT/PackageInfo" 2>/dev/null; then refuse "A path from this Mac is in the package."; fi
if strings -a "$INSIDE/bin/$ENGINE" | grep -F "$HOME"; then refuse "A path from this Mac is in the engine."; fi
print "engine: version $VERSION, $ARCHS, $(codesign -dv "$INSIDE/bin/$ENGINE" 2>&1 | grep -E '^Signature' )"
UPDATE_KEY=$(grep -oE "^  var KEYS = \{ '[0-9a-f]{16}'" "$INSIDE/client/update.js" | grep -oE '[0-9a-f]{16}') || refuse "The panel in the payload carries no update key, so it couldn't update itself."
print "update key: $UPDATE_KEY, installs into ~$LOCATION"

if [[ -f "$INSIDE/META-INF/signatures.xml" ]]; then
  print "extension signature: present"
elif [[ $2 == --require-signature ]]; then
  refuse "The extension in this package isn't signed. Premiere wouldn't load it."
else
  print "extension signature: NONE. This package is for inspection only."
fi
print "package signature: $(pkgutil --check-signature "$PKG" | sed -n 's/^ *Status: //p' | head -1)"
print "Gatekeeper today: $(spctl --assess --type install "$PKG" 2>&1 | tail -1)"
