#!/bin/zsh
# Stamps product.conf into an assembled panel folder: the name, ids and version in the manifest and the host script, and
# the repository in the two places the panel names it, where it looks for updates and where bugs go. This is the only
# way REPO reaches a build: point it at a throwaway repository in product.conf to rehearse an update (docs/RELEASING.md),
# and nobody edits update.js by hand. scripts/build-panel.sh runs it.
#   scripts/stamp-panel.sh <panel folder> [product.conf]
set -e -o pipefail
refuse() { print -u2 -- "$1"; exit 1 }
DIR=${1:?usage: scripts/stamp-panel.sh <panel folder> [product.conf]}
CONF=${2:-${0:A:h}/../product.conf}
source $CONF
[[ $VERSION =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]] || refuse "VERSION in $CONF should look like 1.2.3, not $VERSION."
[[ $REPO =~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' ]] || refuse "REPO in $CONF should look like owner/name, not $REPO."
HOST=$(sed -n 's|.*<ScriptPath>\./\(.*\)</ScriptPath>.*|\1|p' $DIR/CSXS/manifest.xml)
[[ -n $HOST && -f $DIR/$HOST ]] || refuse "$DIR has no host script named in its manifest."

sed -i '' -E \
  -e "s/(ExtensionBundleId=\")[^\"]*/\1$BUNDLE_ID/" \
  -e "s/(ExtensionBundleName=\")[^\"]*/\1$NAME/" \
  -e "s/(ExtensionBundleVersion=\")[^\"]*/\1$VERSION/" \
  -e "s/(<Extension Id=\")[^\"]*/\1$BUNDLE_ID.panel/" \
  -e "s/(<Extension Id=\"[^\"]*\" Version=\")[^\"]*/\1$VERSION/" \
  -e "s|<Menu>[^<]*</Menu>|<Menu>$NAME</Menu>|" \
  $DIR/CSXS/manifest.xml
sed -i '' -E "s/^(var [A-Z_]*HOST_VERSION = ')[^']*/\1$VERSION/" $DIR/$HOST
sed -i '' -E "s|^(  var REPO = ')[^']*';|\1$REPO';|" $DIR/client/update.js
sed -i '' -E "s|(var ISSUES_URL = 'https://github.com/)[^']*/issues/new';|\1$REPO/issues/new';|" $DIR/client/app.js

xmllint --noout $DIR/CSXS/manifest.xml
[[ $(grep -c "\"$VERSION\"" $DIR/CSXS/manifest.xml) -ge 2 ]] || refuse "The manifest didn't take version $VERSION."
grep -qE "HOST_VERSION = '$VERSION'" $DIR/$HOST || refuse "The host script didn't take version $VERSION."
[[ $(grep -c "^  var REPO = '$REPO';" $DIR/client/update.js) == 1 ]] || refuse "update.js didn't take the repository $REPO."
[[ $(grep -c "var ISSUES_URL = 'https://github.com/$REPO/issues/new';" $DIR/client/app.js) == 1 ]] || refuse "app.js didn't take the repository $REPO."
print "stamped $DIR: $NAME $VERSION, $BUNDLE_ID, updates from $REPO"
