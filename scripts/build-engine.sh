#!/bin/zsh
# Builds the universal engine in engine/build with the Command Line Tools swiftc. No Xcode needed.
# The name, bundle id, version and minimum macOS come from product.conf and nowhere else.
set -e -o pipefail
cd "${0:A:h}/.."
source ./product.conf
GEN=engine/build/gen
mkdir -p $GEN

print -r -- "// Written by scripts/build-engine.sh from product.conf.
let engineVersion = \"$VERSION\"
let productName = \"$NAME\"
let bundleId = \"$BUNDLE_ID\"
let engineName = \"$ENGINE\"" > $GEN/Version.swift

for ARCH in arm64 x86_64; do
  mkdir -p engine/build/$ARCH
  swiftc -Ounchecked -wmo -swift-version 5 -target $ARCH-apple-macos$MIN_MACOS \
      -file-prefix-map "$PWD=." \
      engine/Sources/*.swift $GEN/Version.swift \
      -framework VideoToolbox -framework CoreMedia -framework CoreVideo \
      -framework AudioToolbox -framework ImageIO -framework CoreGraphics \
      -framework Vision -framework SoundAnalysis -framework AVFAudio -framework Accelerate \
      -o engine/build/$ARCH/$ENGINE
done

OUT=engine/build/$ENGINE
rm -f $OUT
lipo -create engine/build/arm64/$ENGINE engine/build/x86_64/$ENGINE -output $OUT
# An ad hoc signature needs no certificate. Apple silicon won't run code without one, and lipo leaves each slice as it was.
codesign --force --sign - --identifier $BUNDLE_ID.engine $OUT
chmod 755 $OUT

SLICES=$(lipo -archs $OUT)
[[ $SLICES == *arm64* && $SLICES == *x86_64* ]] || { print -u2 "Expected arm64 and x86_64, got: $SLICES"; exit 1 }
# The universal file runs the slice for this Mac, so the check works on Intel and Apple silicon alike. Where Rosetta is
# there, Apple silicon checks the Intel slice too.
[[ $($OUT version) == $VERSION ]] || { print -u2 "The engine doesn't report $VERSION on this $(uname -m) Mac."; exit 1 }
if [[ $(uname -m) == arm64 ]] && arch -x86_64 /usr/bin/true 2>/dev/null; then
  [[ $(arch -x86_64 $OUT version) == $VERSION ]] || { print -u2 "The x86_64 engine doesn't report $VERSION under Rosetta."; exit 1 }
fi
print "built $OUT, version $VERSION, $SLICES, macOS $MIN_MACOS or later"
