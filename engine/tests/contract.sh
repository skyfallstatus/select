#!/bin/zsh
# Exercises the engine's public contract on tiny clips made with ffmpeg. Needs no footage.
# Everything is written to a temp folder that goes away afterwards. Stops itself after 5 minutes.
# Without ffmpeg only the command line checks run, and it says so.
#   engine/tests/contract.sh [path to engine]
cd "${0:A:h}/../.."
source ./product.conf
B=${1:-$PWD/engine/build/$ENGINE}
[[ -x $B ]] || { echo "No engine at $B. Run scripts/build-engine.sh first."; exit 1 }
T=$(mktemp -d "${TMPDIR:-/tmp}/engine-contract.XXXXXX") || exit 1
pass=0; failn=0
WATCHDOG=
cleanup() { [[ -n $WATCHDOG ]] && kill $WATCHDOG 2>/dev/null; pkill -f "$T" 2>/dev/null; rm -rf "$T" }
trap cleanup EXIT
trap 'echo "Stopped: out of time or interrupted."; exit 3' TERM INT
( sleep 300; kill -TERM $$ ) >/dev/null 2>&1 &!
WATCHDOG=$!

ok() { if [[ $2 == "$3" ]]; then pass=$((pass+1)); echo "ok   $1"; else failn=$((failn+1)); echo "FAIL $1: got '$2' want '$3'"; fi }
at_most() { if (( $2 <= $3 )); then pass=$((pass+1)); echo "ok   $1 ($2)"; else failn=$((failn+1)); echo "FAIL $1: got $2, limit $3"; fi }
limit() { perl -e 'alarm shift; exec @ARGV' "$@" }     # kills a command that hangs
scan() { limit 60 $B scan "$@" }
field() { python3 -c 'import json,sys; [print(json.dumps(eval(sys.argv[1], {"m": json.loads(l)}))) for l in sys.stdin if eval(sys.argv[2], {"m": json.loads(l)})]' "$1" "$2" }

ok "version" "$($B version)" "$VERSION"
ok "--version" "$($B --version)" "$VERSION"
$B >/dev/null 2>&1; ok "no args exit 2" $? 2
$B scan >/dev/null 2>&1; ok "no paths exit 2" $? 2
$B scan --paths-file x --tier 5 >/dev/null 2>&1; ok "bad tier exit 2" $? 2
$B scan --paths-file x --bogus >/dev/null 2>&1; ok "bad flag exit 2" $? 2
$B scan --paths-file /nonexistent/list >/dev/null 2>&1; ok "unreadable list exit 2" $? 2

if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo "SKIP the rest: ffmpeg and ffprobe make the test clips and aren't installed. brew install ffmpeg"
  echo "$pass passed, $failn failed, clip tests skipped"
  (( failn == 0 )); exit
fi

# ---- tiny clips
G=(ffmpeg -v error -nostdin -y -f lavfi -i testsrc2=s=320x180:r=25:d=1 -f lavfi -i sine=f=440:r=48000:d=1)
limit 60 $G -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest $T/s1.mp4 || exit 1
limit 60 $G -c:v libx264 -pix_fmt yuv422p10le -profile:v high422 -g 1 -c:a pcm_s16le -shortest $T/intra422.mov || exit 1
limit 60 $G -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p10le -x265-params log-level=error -c:a aac -shortest $T/hevc.mp4 || exit 1
limit 60 $G -c:v prores_ks -profile:v 2 -pix_fmt yuv422p10le -c:a pcm_s16le -shortest $T/prores.mov || exit 1
limit 60 $G -c:v mpeg2video -pix_fmt yuv422p -c:a pcm_s16le -shortest $T/clip.mxf || exit 1
limit 60 $G -c:v ffv1 -pix_fmt yuv420p -c:a pcm_s16le -shortest $T/nodecoder.mov || exit 1
limit 60 $G -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -movflags frag_keyframe+empty_moov $T/frag.mp4 || exit 1
mkdir $T/m
for i in {1..12}; do cp $T/${${:-s1.mp4 intra422.mov hevc.mp4 prores.mov}[(w)$(( (i - 1) % 4 + 1 ))]} $T/m/c$i.${${:-mp4 mov mp4 mov}[(w)$(( (i - 1) % 4 + 1 ))]}; done
print -l $T/m/* > $T/twelve.txt

# ---- the scan contract
{ cat $T/twelve.txt; echo "$T/definitely-not-here.mp4" } > $T/l.txt
out=$(scan --paths-file $T/l.txt --cache $T/c 2>/dev/null); ok "exit 0 with a failed clip" $? 0
ok "start line first" "$(echo "$out" | head -1 | cut -c1-22)" '{"type":"start","total'
ok "error line" "$(echo "$out" | grep -c '"type":"error"')" 1
ok "done counts" "$(echo "$out" | tail -1 | sed 's/,"wallMs.*//')" '{"type":"done","clips":12,"failed":1,"cached":0'
ok "all lines are JSON" "$(echo "$out" | python3 -c 'import sys,json; print(sum(1 for l in sys.stdin if json.loads(l)))')" 27
ok "every clip has picture data" "$(echo "$out" | grep -c '"sharpness":[0-9]')" 12
out=$(cat $T/l.txt | scan --paths-file - --cache $T/c 2>/dev/null); ok "stdin paths and full cache" "$(echo "$out" | tail -1 | sed 's/,"wallMs.*//')" '{"type":"done","clips":12,"failed":1,"cached":12'
ok "cached flag set" "$(echo "$out" | grep -c '"cached":true')" 24
ok "tier 0 only" "$(scan --paths-file $T/l.txt --cache $T/c0 --tier 0 2>/dev/null | grep -c '"tier":1')" 0
ok "no-thumbs gives null" "$(scan --paths-file $T/l.txt --cache $T/c1 --no-thumbs 2>/dev/null | grep -c '"thumb":null')" 12
ok "thumbs after no-thumbs" "$(scan --paths-file $T/l.txt --cache $T/c1 2>/dev/null | grep -c '"thumb":"/')" 12
cp $T/s1.mp4 $T/m.mp4; echo $T/m.mp4 > $T/one.txt
scan --paths-file $T/one.txt --cache $T/c2 >/dev/null 2>&1
ok "unchanged file cached" "$(scan --paths-file $T/one.txt --cache $T/c2 2>/dev/null | tail -1 | grep -c '"cached":1')" 1
python3 -c "import os;os.utime('$T/m.mp4',ns=(1700000000123456789,1700000000123456789))"; scan --paths-file $T/one.txt --cache $T/c2b >/dev/null 2>&1
ok "nanosecond mtime still hits" "$(scan --paths-file $T/one.txt --cache $T/c2b 2>/dev/null | tail -1 | grep -c '"cached":1')" 1
touch -t 202001010101 $T/m.mp4
ok "changed mtime misses" "$(scan --paths-file $T/one.txt --cache $T/c2 2>/dev/null | tail -1 | grep -c '"cached":0')" 1
for i in {1..400}; do cat $T/twelve.txt; done > $T/long.txt
$B scan --paths-file $T/long.txt --cache $T/c3 --workers 2 > $T/term.out 2>/dev/null &
pid=$!; sleep 0.2; kill -TERM $pid; wait $pid; ok "SIGTERM stops" $? 143
scan --paths-file $T/long.txt --cache $T/c4 --workers 2 2>/dev/null | head -2 >/dev/null; sleep 0.2; ok "closed stdout leaves no process" "$(pgrep -f "cache $T/c4" | wc -l | tr -d ' ')" 0
head -c 4096 $T/s1.mp4 > $T/bad.mp4; echo $T/bad.mp4 > $T/bad.txt; scan --paths-file $T/bad.txt --cache $T/c6 >/dev/null 2>&1
ok "broken clip is tried again next scan, never a stale verdict" "$(scan --paths-file $T/bad.txt --cache $T/c6 2>/dev/null | tail -1 | grep -c '"failed":1,"cached":1')" 0
echo "$T/gone.mp4" > $T/gone.txt; scan --paths-file $T/gone.txt --cache $T/c7 >/dev/null 2>&1; ok "missing file is not cached" "$(grep -c gone $T/c7/index-v1.tsv 2>/dev/null)" 0
mkdir -p $T/c8; for i in {1..400}; do print -r -- $'0\t1\t1.000000\t"/x/stale.mp4"\t"name":"s"'; done > $T/c8/index-v1.tsv
scan --paths-file $T/one.txt --cache $T/c8 >/dev/null 2>&1; ok "stale index lines are compacted" "$(test $(wc -l < $T/c8/index-v1.tsv) -lt 40 && echo yes)" yes
ok "stderr only for logs" "$(scan --paths-file $T/one.txt --cache $T/c5 2>/dev/null | grep -vc '^{')" 0

# ---- no ffmpeg on the machine
export_no() { ENGINE_TEST_NO_FFMPEG=1 limit 60 $B scan "$@" }
echo $T/clip.mxf > $T/mxf.txt
out=$(export_no --paths-file $T/mxf.txt --cache $T/n1 2>/dev/null); ok "MXF without ffmpeg exits 0" $? 0
ok "MXF without ffmpeg is an error line" "$(echo "$out" | field m.get\(\"message\"\) 'm["type"]=="error"')" '"MXF files need ffmpeg (ffmpeg not found on this Mac). Most MP4 and MOV clips work without it."'
ok "MXF error is not remembered" "$(scan --paths-file $T/mxf.txt --cache $T/n1 2>/dev/null | grep -c '"tier":1')" 1
echo $T/frag.mp4 > $T/frag.txt
ok "fragmented without ffmpeg is an error line" "$(export_no --paths-file $T/frag.txt --cache $T/n2 2>/dev/null | grep -c 'This clip needs ffmpeg')" 1
echo $T/nodecoder.mov > $T/nd.txt
out=$(export_no --paths-file $T/nd.txt --cache $T/n3 2>/dev/null); ok "no system decoder, no ffmpeg exits 0" $? 0
ok "  Tier 0 stays" "$(echo "$out" | field m.get\(\"codec\"\) 'm.get("tier")==0')" '"ffv1"'
ok "  Tier 1 fields are null" "$(echo "$out" | field 'm.get("sharpness"),m.get("luma"),m.get("dhash"),m.get("thumb")' 'm.get("tier")==1')" '[null, null, null, null]'
ok "  sound still measured" "$(echo "$out" | field 'm.get("audioDb") is not None' 'm.get("tier")==1')" true
ok "  a reason in words" "$(echo "$out" | grep -c '"reason":"This Mac has no decoder for ffv1')" 1
ok "  counted as degraded, not failed" "$(echo "$out" | tail -1 | field 'm["clips"],m["failed"],m["degraded"]' 'True')" '[1, 0, 1]'
ok "  not remembered, ffmpeg can fill it in later" "$(scan --paths-file $T/nd.txt --cache $T/n3 2>/dev/null | grep -c '"sharpness":[0-9]')" 1

# ffmpeg really out of reach, with no help from the engine. Skips where sandbox-exec is missing.
FF_DIR=${$(command -v ffmpeg):h}
if command -v sandbox-exec >/dev/null && [[ $FF_DIR != /usr/bin ]]; then
  SB="(version 1)(allow default)(deny file-read* process-exec (subpath \"$FF_DIR\"))"
  out=$(limit 60 sandbox-exec -p "$SB" $B scan --paths-file $T/mxf.txt --cache $T/n4 2>/dev/null); ok "sandboxed from ffmpeg, MXF exits 0" $? 0
  ok "sandboxed from ffmpeg, MXF says so" "$(echo "$out" | grep -c 'ffmpeg not found')" 1
  out=$(limit 60 sandbox-exec -p "$SB" $B scan --paths-file $T/nd.txt --cache $T/n5 2>/dev/null); ok "sandboxed from ffmpeg, no decoder exits 0" $? 0
  ok "sandboxed from ffmpeg, no decoder degrades" "$(echo "$out" | tail -1 | field 'm["degraded"]' 'True')" 1
else
  echo "SKIP sandbox check: sandbox-exec missing, or ffmpeg is in /usr/bin"
fi

# ---- a Mac without the decoder: forced, because no Mac here lacks one
mkdir $T/x; for i in {1..240}; do ln $T/intra422.mov $T/x/a$i.mov; done; print -l $T/x/* > $T/many.txt
forced() { local mode=$1; shift; ENGINE_TEST_DECODER=$mode ENGINE_TEST_NO_FFMPEG=1 limit 60 $B scan --paths-file $T/many.txt "$@" }
for mode in open frame; do
  out=$(forced $mode --cache $T/f$mode --no-thumbs 2>$T/f$mode.err); ok "forced $mode failure exits 0" $? 0
  ok "  240 clips keep Tier 0" "$(echo "$out" | grep -c '"tier":0.*"bitDepth":10,"chroma":"422"')" 240
  ok "  240 clips get null Tier 1 and a reason" "$(echo "$out" | grep '"tier":1' | grep '"luma":null' | grep -c '"reason":"This Mac')" 240
  ok "  done says degraded" "$(echo "$out" | tail -1 | field 'm["clips"],m["failed"],m["degraded"]' 'True')" '[240, 0, 240]'
  tries=$(grep -oE 'vt-refused=[0-9]+' $T/f$mode.err | cut -d= -f2)
  at_most "  attempts stay bounded, of 240 clips" ${tries:-999} 18
  at_most "  wall ms" "$(echo "$out" | tail -1 | field 'm["wallMs"]' 'True')" 3000
done
ok "reason names the format" "$(forced open --cache $T/f3 --no-thumbs 2>/dev/null | grep -c 'no decoder for H.264 10-bit 4:2:2')" 240

# The same clips with ffmpeg there take the slow route and get real numbers.
print -l $T/x/a{1..8}.mov > $T/some.txt
out=$(ENGINE_TEST_DECODER=open limit 60 $B scan --paths-file $T/some.txt --cache $T/f4 2>/dev/null)
ok "decoder missing, ffmpeg fills in" "$(echo "$out" | grep -c '"sharpness":[0-9]')" 8
ok "  and no reason is given" "$(echo "$out" | grep -c '"reason"')" 0
ok "  and thumbnails are written" "$(echo "$out" | grep -c '"thumb":"/')" 8

# Stopping must take running ffmpegs with it. The long list only keeps it busy until the stop arrives.
for i in {1..10}; do cat $T/many.txt; done > $T/lots.txt
ENGINE_TEST_DECODER=open $B scan --paths-file $T/lots.txt --cache $T/f5 --no-thumbs >/dev/null 2>&1 &
pid=$!; seen=no
for i in {1..200}; do if pgrep -f "ffmpeg.*$T" >/dev/null; then seen=yes; break; fi; done
kill -TERM $pid; wait $pid; sleep 0.2
ok "ffmpeg was running when stopped" $seen yes
ok "SIGTERM leaves no ffmpeg behind" "$(pgrep -f "ffmpeg.*$T" | wc -l | tr -d ' ')" 0

echo "$pass passed, $failn failed"
(( failn == 0 ))
