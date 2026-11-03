#!/bin/zsh
# Builds a release and uploads it to GitHub Releases. Only ever run by hand.
#   scripts/release.sh --dry-run     everything but the upload
#   scripts/release.sh               the same, then asks before it uploads
# Needs what scripts/sign-zxp.sh needs from the environment, and the update key that scripts/sign-update.js reads from
# ~/.config/skyfallstatus/signing. The steps are in docs/RELEASING.md.
#
# A mistake here reaches every tester, and a bad signature fails quietly: the panel just isn't there. So this refuses a
# changed tree, a version that isn't higher than the last, an update key the copies already installed don't trust,
# private words, and anything unsigned, and looks at GitHub, read-only, only on a real run.
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
# Before the long part: installed copies only take a release signed with the key they carry. That's the key in this
# panel for the copies this release installs, and the key in the last release's panel for every copy already out there.
node scripts/sign-update.js check-key || refuse "Without the update key, installed copies couldn't update to this release."
if (( DRY )); then
  # No GitHub on a dry run: the newest release tag here stands in for the last release.
  LAST=$(git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname | head -1)
  LAST_REF=$LAST
elif [[ -n $LAST ]]; then
  # The tag as GitHub has it for $REPO, read-only and without making a local tag: a local one could be a rehearsal's.
  git fetch --quiet --no-tags "https://github.com/$REPO.git" "refs/tags/$LAST" || refuse "Can't fetch $LAST from GitHub, so can't check the key the copies installed from it carry."
  LAST_REF=FETCH_HEAD
fi
if [[ -n $LAST ]]; then
  if git cat-file -e "$LAST_REF:panel/client/update.js" 2>/dev/null; then
    OLD_PANEL=$(mktemp -d)
    git show "$LAST_REF:panel/client/update.js" > $OLD_PANEL/update.js
    node scripts/sign-update.js check-key $OLD_PANEL/update.js || { rm -rf $OLD_PANEL; refuse "Copies installed from $LAST couldn't update to this release: the panel they carry doesn't trust this update key."; }
    rm -rf $OLD_PANEL
  else
    print "$LAST has no updater, so no copy installed from it checks the update key."
  fi
fi
scripts/test.sh
scripts/privacy-scan.sh
scripts/build-panel.sh
scripts/sign-zxp.sh
scripts/build-pkg.sh
scripts/check-pkg.sh dist/$NAME.pkg --require-signature
TOOL=${ZXPSIGNCMD:-$(command -v ZXPSignCmd)}
[[ $("$TOOL" -verify dist/$NAME.zxp || true) == *"Signature verified successfully"* ]] || refuse "dist/$NAME.zxp isn't signed."
[[ $("$TOOL" -verify dist/signed/$BUNDLE_ID || true) == *"Signature verified successfully"* ]] || refuse "The folder in the installer isn't signed."

# The manifest installed copies check before they take dist/$NAME.zxp, checked against the key the new panel carries.
MANIFEST=dist/$NAME-update.json
node scripts/sign-update.js sign dist/$NAME.zxp $MANIFEST dist/signed/$BUNDLE_ID/client/update.js

# The install steps in the notes are README's, word for word.
NOTES=dist/release-notes.md
{
  print "$NAME $VERSION."
  print
  print "## Install"
  awk '/^### Steps$/ { on = 1; next } on && /^##/ { exit } on' README.md
  print "Already on $NAME 0.2 or later? It updates itself. **··· › Check for Updates** asks now."
  print
  print "What to try, and what to send back: [BETA.md](https://github.com/$REPO/blob/$TAG/BETA.md)."
} > $NOTES
[[ $(grep -cE '^[0-9]+\. ' $NOTES) -ge 3 ]] || refuse "The install steps didn't come out of README.md. Check its ### Steps section."
ASSETS=(dist/$NAME.pkg dist/$NAME.zxp $MANIFEST)

print "${ASSETS[*]} are ready for $TAG. Notes: $NOTES"
(( DRY )) && exit 0
read "ANSWER?Upload $TAG to $REPO for everyone? Type yes: "
[[ $ANSWER == yes ]] || { print "Nothing uploaded."; exit 1 }
[[ $(git rev-parse HEAD) == $COMMIT && -z $(git status --porcelain) ]] || refuse "The tree moved while this was building. Nothing uploaded."
# A draft first, so releases/latest never shows a release whose files are still uploading. Installed copies ask that URL.
gh release create $TAG $ASSETS --repo $REPO --target $COMMIT --title "$NAME $VERSION" --notes-file $NOTES --draft
UPLOADED=$(gh release view $TAG --repo $REPO --json assets --jq '[.assets[] | "\(.name) \(.size)"] | sort | join(",")')
EXPECTED=$(for f in $ASSETS; do print "${f:t} $(stat -f %z $f)"; done | LC_ALL=C sort | paste -sd, -)
[[ $UPLOADED == $EXPECTED ]] || refuse "The draft's files aren't what was built ($UPLOADED). It's still a draft: fix it on GitHub or delete it."
gh release edit $TAG --repo $REPO --draft=false --latest
print "released $TAG"
