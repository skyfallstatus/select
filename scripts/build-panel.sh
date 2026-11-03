#!/bin/zsh
# Assembles dist/<bundle id>: the panel with the engine inside, and nothing a tester doesn't need.
# Copies only the folders it names, so tests and .debug can't come along. Name, ids, version and repository are stamped
# from product.conf by scripts/stamp-panel.sh.
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
# The updater's side: the repository it asks (stamped below, so it must be there to stamp), the engine it tries, and the
# host version it reads after a restart.
grep -q "^  var REPO = '[^']*';" panel/client/update.js || refuse "panel/client/update.js has no REPO line for the build to stamp."
grep -q "var ISSUES_URL = 'https://github.com/[^']*/issues/new';" panel/client/app.js || refuse "panel/client/app.js has no ISSUES_URL line for the build to stamp."
grep -q "^  var ENGINE = '$ENGINE';" panel/client/update.js || refuse "panel/client/update.js checks an engine that isn't called $ENGINE."
grep -q "^var SELECT_HOST_VERSION = '" panel/$HOST || refuse "$HOST doesn't define SELECT_HOST_VERSION, which panel/client/update.js reads after an update."
grep -q '<script src="update.js"></script>' panel/client/index.html || refuse "panel/client/index.html doesn't load update.js, so this build couldn't update itself."

rm -rf $OUT
mkdir -p $OUT/bin
for FOLDER in CSXS client host; do
  ditto --norsrc --noextattr --noqtn panel/$FOLDER $OUT/$FOLDER
done
ditto --norsrc --noextattr --noqtn $BUILT $OUT/bin/$ENGINE

scripts/stamp-panel.sh $OUT

find $OUT -name .DS_Store -delete
find $OUT -type d -exec chmod 755 {} +
find $OUT -type f -exec chmod 644 {} +
chmod 755 $OUT/bin/$ENGINE

[[ -z $(find $OUT \( -name .debug -o -name test -o -name '*.test.js' -o -type l \)) ]] || refuse "Something that must not ship is in $OUT."
[[ $(codesign --verify $OUT/bin/$ENGINE 2>&1) == "" ]] || refuse "The engine's own signature doesn't verify."
print "assembled $OUT, version $VERSION, $(du -sh $OUT | cut -f1 | tr -d ' ')"
