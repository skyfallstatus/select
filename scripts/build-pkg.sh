#!/bin/zsh
# Builds dist/<name>.pkg from the signed folder that scripts/sign-zxp.sh leaves in dist/signed.
# It installs for all users into Adobe's system extensions folder, with no scripts, and asks for an admin password.
#   scripts/build-pkg.sh                   the real one. Refuses a folder with no signature
#   scripts/build-pkg.sh --unsigned-test   dist/<name>-UNSIGNED-test.pkg, to inspect the build. Premiere won't load it
# INSTALLER_IDENTITY, when set to a Developer ID Installer identity, signs the package itself. Without one,
# macOS asks the tester to approve it in System Settings. See docs/PACKAGING.md.
set -e -o pipefail
cd "${0:A:h}/.."
refuse() { print -u2 -- "$1"; exit 1 }
source ./product.conf
LOCATION="/Library/Application Support/Adobe/CEP/extensions/$BUNDLE_ID"

if [[ $1 == --unsigned-test ]]; then
  SOURCE=dist/$BUNDLE_ID
  OUT=dist/$NAME-UNSIGNED-test.pkg
else
  SOURCE=dist/signed/$BUNDLE_ID
  OUT=dist/$NAME.pkg
  [[ -f $SOURCE/META-INF/signatures.xml ]] || refuse "No signed folder at $SOURCE. Run scripts/sign-zxp.sh first. Without a signature Premiere won't load the panel."
fi
[[ -d $SOURCE ]] || refuse "Nothing at $SOURCE. Run scripts/build-panel.sh first."

WORK=$(mktemp -d "${TMPDIR:-/tmp}/pkg-work.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
ROOT=$WORK/root
mkdir -p $ROOT $WORK/resources $WORK/component
ditto --norsrc --noextattr --noqtn $SOURCE $ROOT

# The component is put together by hand. pkgbuild writes a stray empty ._ file beside every file that carries an extended
# attribute, macOS adds one to everything a tool writes, and those files would land inside the signed extension.
# The payload is the extension folder itself, so the package never touches the permissions of the folders above it.
(cd $ROOT && find . | COPYFILE_DISABLE=1 cpio -o --format odc --owner 0:0 2>/dev/null) | gzip -9 > $WORK/component/Payload
mkbom $ROOT $WORK/mine.bom
lsbom $WORK/mine.bom | sed -E 's|	[0-9]+/[0-9]+|	0/0|' > $WORK/rooted.txt
mkbom -i $WORK/rooted.txt $WORK/component/Bom
cat > $WORK/component/PackageInfo <<XML
<?xml version="1.0" encoding="utf-8"?>
<pkg-info format-version="2" identifier="$BUNDLE_ID" version="$VERSION" install-location="$LOCATION" auth="root" relocatable="false" overwrite-permissions="true" postinstall-action="none">
    <payload numberOfFiles="$(find $ROOT | wc -l | tr -d ' ')" installKBytes="$(du -sk $ROOT | cut -f1)"/>
</pkg-info>
XML
pkgutil --flatten $WORK/component $WORK/component.pkg

cat > $WORK/resources/conclusion.html <<HTML
<html><body style="font-family: -apple-system, sans-serif; font-size: 13px">
<p><b>$NAME is installed.</b></p>
<p>Quit Premiere if it's open, then open it again. You'll find $NAME under <b>Window &rsaquo; Extensions</b>.</p>
</body></html>
HTML

# hostArchitectures keeps Apple silicon from asking for Rosetta. Without it the Installer treats the package as Intel only.
cat > $WORK/Distribution.xml <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>$NAME</title>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <volume-check><allowed-os-versions><os-version min="$MIN_MACOS"/></allowed-os-versions></volume-check>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <choices-outline><line choice="default"><line choice="$BUNDLE_ID"/></line></choices-outline>
  <choice id="default"/>
  <choice id="$BUNDLE_ID" visible="false"><pkg-ref id="$BUNDLE_ID"/></choice>
  <pkg-ref id="$BUNDLE_ID" version="$VERSION" onConclusion="none">component.pkg</pkg-ref>
</installer-gui-script>
XML

rm -f $OUT
BUILD=(productbuild --quiet --distribution $WORK/Distribution.xml --package-path $WORK --resources $WORK/resources)
if [[ -n $INSTALLER_IDENTITY && $OUT == dist/$NAME.pkg ]]; then
  $BUILD --sign "$INSTALLER_IDENTITY" $OUT
else
  $BUILD $OUT
fi
scripts/check-pkg.sh $OUT
print "built $OUT"
