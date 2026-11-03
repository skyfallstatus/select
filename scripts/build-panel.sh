#!/bin/zsh
# Assembles dist/<bundle id>: the panel with the engine inside, and nothing a tester doesn't need.
# Copies only the folders it names, so tests and .debug can't come along. Name, id and version are stamped from product.conf.
set -e -o pipefail
cd "${0:A:h}/.."
refuse() { print -u2 -- "$1"; exit 1 }
source ./product.conf
BUILT=engine/build/$ENGINE
OUT=dist/$BUNDLE_ID

[[ -x $BUILT ]] || refuse "No engine at $BUILT. Run scripts/build-engine.sh first."
[[ $($BUILT version) == $VERSION ]] || refuse "The engine is not version $VERSION. Run scripts/build-engine.sh again."
[[ -z $(find panel/CSXS panel/client panel/host -type l) ]] || refuse "The panel has a symbolic link in it. Adobe's installer breaks them, which fails the signature. Replace it with the file."

# The folder name and the two names below are the panel's side of product.conf. A mismatch only shows up in Premiere.
HOST=$(sed -n 's|.*<ScriptPath>\./\(.*\)</ScriptPath>.*|\1|p' panel/CSXS/manifest.xml)
[[ -f panel/$HOST ]] || refuse "The manifest names $HOST, and it isn't in panel/."
grep -q "/bin/$ENGINE'" panel/client/app.js || refuse "The panel doesn't run an engine called $ENGINE. Check panel/client/app.js."

rm -rf $OUT
mkdir -p $OUT/bin
for FOLDER in CSXS client host; do
  ditto --norsrc --noextattr --noqtn panel/$FOLDER $OUT/$FOLDER
done
ditto --norsrc --noextattr --noqtn $BUILT $OUT/bin/$ENGINE

sed -i '' -E \
  -e "s/(ExtensionBundleId=\")[^\"]*/\1$BUNDLE_ID/" \
  -e "s/(ExtensionBundleName=\")[^\"]*/\1$NAME/" \
  -e "s/(ExtensionBundleVersion=\")[^\"]*/\1$VERSION/" \
  -e "s/(<Extension Id=\")[^\"]*/\1$BUNDLE_ID.panel/" \
  -e "s/(<Extension Id=\"[^\"]*\" Version=\")[^\"]*/\1$VERSION/" \
  -e "s|<Menu>[^<]*</Menu>|<Menu>$NAME</Menu>|" \
  $OUT/CSXS/manifest.xml
sed -i '' -E "s/^(var [A-Z_]*HOST_VERSION = ')[^']*/\1$VERSION/" $OUT/$HOST

find $OUT -name .DS_Store -delete
find $OUT -type d -exec chmod 755 {} +
find $OUT -type f -exec chmod 644 {} +
chmod 755 $OUT/bin/$ENGINE

xmllint --noout $OUT/CSXS/manifest.xml
[[ $(grep -c "\"$VERSION\"" $OUT/CSXS/manifest.xml) -ge 2 ]] || refuse "The manifest didn't take version $VERSION."
grep -qE "HOST_VERSION = '$VERSION'" $OUT/$HOST || refuse "The host script didn't take version $VERSION."
[[ -z $(find $OUT \( -name .debug -o -name test -o -name '*.test.js' -o -type l \)) ]] || refuse "Something that must not ship is in $OUT."
[[ $(codesign --verify $OUT/bin/$ENGINE 2>&1) == "" ]] || refuse "The engine's own signature doesn't verify."
print "assembled $OUT, version $VERSION, $(du -sh $OUT | cut -f1 | tr -d ' ')"
