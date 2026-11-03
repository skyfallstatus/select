#!/bin/zsh
# Signs dist/<bundle id> with Adobe's ZXPSignCmd, writes dist/<name>.zxp, and unpacks it to
# dist/signed/<bundle id>, which is the folder the installer carries.
# Nothing secret is kept here. It comes from the environment, and docs/RELEASING.md says how to make it:
#   ZXP_CERT       path to the .p12 certificate, kept outside this repo
#   ZXP_PASSWORD   its password
#   ZXPSIGNCMD              path to ZXPSignCmd, if it isn't on your PATH
#   ZXP_TSA        timestamp server, optional
set -e -o pipefail
cd "${0:A:h}/.."
refuse() { print -u2 -- "$1"; exit 1 }
source ./product.conf
IN=dist/$BUNDLE_ID
ZXP=dist/$NAME.zxp
SIGNED=dist/signed/$BUNDLE_ID
TSA=${ZXP_TSA:-http://timestamp.digicert.com}

TOOL=${ZXPSIGNCMD:-$(command -v ZXPSignCmd || true)}
[[ -n $TOOL && -x $TOOL ]] || refuse "ZXPSignCmd isn't here, so nothing was signed. Get it from https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD and set ZXPSIGNCMD to its path. docs/RELEASING.md has the steps."
[[ -n $ZXP_CERT ]] || refuse "ZXP_CERT isn't set, so nothing was signed. Point it at your .p12 file. docs/RELEASING.md says how to make one."
[[ -f $ZXP_CERT ]] || refuse "There's no certificate at the path in ZXP_CERT, so nothing was signed."
[[ -n $ZXP_PASSWORD ]] || refuse "ZXP_PASSWORD isn't set, so nothing was signed."
[[ ${ZXP_CERT:A} != ${PWD}/* || ${ZXP_CERT:A} == ${PWD}/.local/* ]] || refuse "Keep the certificate outside the repository, not at $ZXP_CERT."
[[ -d $IN ]] || refuse "Nothing to sign at $IN. Run scripts/build-panel.sh first."

# Adobe's macOS ZXPSignCmd is an Intel program. On Apple silicon it needs Rosetta, and without it the failure is cryptic.
if [[ $(uname -m) == arm64 && $(lipo -archs $TOOL 2>/dev/null) == x86_64 && $(arch -x86_64 $TOOL 2>&1 || true) == *"Bad CPU"* ]]; then
  refuse "ZXPSignCmd is an Intel program and this Mac has no Rosetta. Install it with: softwareupdate --install-rosetta"
fi

rm -f $ZXP
rm -rf dist/signed
"$TOOL" -sign $IN $ZXP "$ZXP_CERT" "$ZXP_PASSWORD" -tsa $TSA
[[ -s $ZXP ]] || refuse "ZXPSignCmd wrote no file."

CHECK=$("$TOOL" -verify $ZXP -certinfo || true)
print -r -- "$CHECK"
[[ $CHECK == *"Signature verified successfully"* ]] || refuse "The signature on $ZXP doesn't verify."
[[ $CHECK == *"Timestamp: Valid"* ]] || refuse "$ZXP has no valid timestamp, so it would stop working when the certificate expires. Try another server in ZXP_TSA."

mkdir -p $SIGNED
ditto -x -k $ZXP $SIGNED
[[ -f $SIGNED/META-INF/signatures.xml ]] || refuse "The unpacked folder has no signature in it."
# A zip may or may not keep the execute bit. Modes aren't part of what's signed, so this is safe, and the check below proves it.
chmod 755 $SIGNED/bin/$ENGINE
cmp -s $IN/bin/$ENGINE $SIGNED/bin/$ENGINE || refuse "The engine in the signed folder differs from the one that was built."
[[ $($SIGNED/bin/$ENGINE version) == $VERSION ]] || refuse "The engine in the signed folder doesn't run."
[[ $("$TOOL" -verify $SIGNED || true) == *"Signature verified successfully"* ]] || refuse "The unpacked folder doesn't verify, so Premiere wouldn't load it."
print "signed $ZXP and $SIGNED"
