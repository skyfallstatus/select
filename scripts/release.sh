#!/bin/zsh
# Builds a release and uploads it to GitHub Releases. Only ever run by hand.
#   scripts/release.sh --dry-run     everything but the upload
#   scripts/release.sh               the same, then asks before it uploads
# Needs what scripts/sign-zxp.sh needs from the environment. The steps are in docs/RELEASING.md.
#
# A mistake here reaches every tester, and a bad signature fails quietly: the panel just isn't there. So this refuses a
# changed tree, a version that isn't higher than the last, private words, and anything unsigned, and looks at GitHub,
# read-only, only on a real run.
set -e -o pipefail
cd "${0:A:h}/.."
refuse() { print -u2 -- "$1"; exit 1 }
autoload -Uz is-at-least
source ./product.conf
DRY=0; [[ $1 == --dry-run ]] && DRY=1
[[ $# -eq 0 || $DRY -eq 1 ]] || refuse "usage: scripts/release.sh [--dry-run]"
TAG=v$VERSION
[[ $VERSION =~ '^[0-9]+\.[0-9]+\.[0-9]+$' ]] || refuse "VERSION in product.conf should look like 1.2.3, not $VERSION."
[[ -z $(git status --porcelain) ]] || refuse "The tree has changes in it. A release is built from a commit."
COMMIT=$(git rev-parse --verify HEAD 2>/dev/null) || refuse "There are no commits yet. A release is built from a commit."
[[ -n $ZXP_CERT && -n $ZXP_PASSWORD ]] || refuse "ZXP_CERT and ZXP_PASSWORD aren't set. An unsigned panel won't load, so there's nothing to release."

if (( ! DRY )); then
  gh api repos/$REPO/commits/$COMMIT --silent 2>/dev/null || refuse "GitHub doesn't have $COMMIT, or can't be reached. Push it first."
  if gh release view $TAG --repo $REPO >/dev/null 2>&1; then refuse "$TAG is already released. Raise VERSION in product.conf."; fi
  LAST=$(gh release list --repo $REPO --limit 1 --exclude-drafts --json tagName --jq '.[0].tagName // ""') || refuse "Can't see this repo's releases, so can't check the version."
  if [[ -n $LAST ]]; then
    is-at-least ${VERSION}.1 ${LAST#v} && refuse "This is $VERSION and the last release is ${LAST#v}. A new one must be higher."
  fi
fi

for tool in ffmpeg ffprobe node; do
  command -v $tool >/dev/null || refuse "$tool isn't installed, so tests would be skipped. A release runs all of them."
done
scripts/test.sh
scripts/privacy-scan.sh
scripts/build-panel.sh
scripts/sign-zxp.sh
scripts/build-pkg.sh
scripts/check-pkg.sh dist/$NAME.pkg --require-signature
TOOL=${ZXPSIGNCMD:-$(command -v ZXPSignCmd)}
[[ $("$TOOL" -verify dist/$NAME.zxp || true) == *"Signature verified successfully"* ]] || refuse "dist/$NAME.zxp isn't signed."
[[ $("$TOOL" -verify dist/signed/$BUNDLE_ID || true) == *"Signature verified successfully"* ]] || refuse "The folder in the installer isn't signed."

print "dist/$NAME.pkg and dist/$NAME.zxp are ready for $TAG."
(( DRY )) && exit 0
read "ANSWER?Upload $TAG to $REPO for everyone? Type yes: "
[[ $ANSWER == yes ]] || { print "Nothing uploaded."; exit 1 }
[[ $(git rev-parse HEAD) == $COMMIT && -z $(git status --porcelain) ]] || refuse "The tree moved while this was building. Nothing uploaded."
gh release create $TAG dist/$NAME.pkg dist/$NAME.zxp --repo $REPO --target $COMMIT --title "$NAME $VERSION" --notes "$NAME $VERSION. See BETA.md."
