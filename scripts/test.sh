#!/bin/zsh
# Everything that needs no footage and no Premiere. Tests that make clips skip clearly if ffmpeg is missing.
#   scripts/test.sh
set -e -o pipefail
cd "${0:A:h}/.."
scripts/build-engine.sh
engine/tests/contract.sh
engine/tests/fuzz.py
if command -v node >/dev/null; then
  (cd panel && node --test test/unit.test.js)
else
  print "SKIP panel unit tests: Node isn't installed."
fi
if [[ -f .local/private-patterns.txt ]]; then
  scripts/privacy-scan.sh
else
  print "SKIP privacy scan: it needs the maintainer's private patterns file."
fi
print "all good"
