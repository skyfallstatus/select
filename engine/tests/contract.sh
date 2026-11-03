#!/bin/zsh
# Exercises the engine's public contract on tiny clips made with ffmpeg. Needs no footage.
# Everything is written to a temp folder that goes away afterwards. Stops itself after 10 minutes.
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
( sleep 600; kill -TERM $$ ) >/dev/null 2>&1 &!
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
ok "all lines are JSON" "$(echo "$out" | python3 -c 'import sys,json; print(sum(1 for l in sys.stdin if json.loads(l)))')" 40
ok "every clip has picture data" "$(echo "$out" | grep -c '"sharpness":[0-9]')" 12
out=$(cat $T/l.txt | scan --paths-file - --cache $T/c 2>/dev/null); ok "stdin paths and full cache" "$(echo "$out" | tail -1 | sed 's/,"wallMs.*//')" '{"type":"done","clips":12,"failed":1,"cached":12'
ok "cached flag set" "$(echo "$out" | grep -c '"cached":true')" 36
ok "tier 0 only" "$(scan --paths-file $T/l.txt --cache $T/c0 --tier 0 2>/dev/null | grep -c '"tier":1')" 0
ok "no-thumbs gives null" "$(scan --paths-file $T/l.txt --cache $T/c1 --no-thumbs --tier 1 2>/dev/null | grep -c '"thumb":null')" 12
ok "thumbs after no-thumbs" "$(scan --paths-file $T/l.txt --cache $T/c1 --tier 1 2>/dev/null | grep -c '"thumb":"/')" 12
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
echo "$T/gone.mp4" > $T/gone.txt; scan --paths-file $T/gone.txt --cache $T/c7 >/dev/null 2>&1; ok "missing file is not cached" "$(grep -c gone $T/c7/index-v4.tsv 2>/dev/null)" 0
mkdir -p $T/c8; for i in {1..400}; do print -r -- $'0\t1\t1.000000\t-\t"/x/stale.mp4"\t"name":"s"'; done > $T/c8/index-v4.tsv
scan --paths-file $T/one.txt --cache $T/c8 >/dev/null 2>&1; ok "stale index lines are compacted" "$(test $(wc -l < $T/c8/index-v4.tsv) -lt 40 && echo yes)" yes
ok "stderr only for logs" "$(scan --paths-file $T/one.txt --cache $T/c5 2>/dev/null | grep -vc '^{')" 0

# ---- a Sony sidecar is part of what a result depends on: camera, lens, date and log grading come from it
mkdir $T/sc; cp $T/s1.mp4 $T/sc/C0001.MP4; print $T/sc/C0001.MP4 > $T/sc.txt
side() { print -r -- "<?xml version=\"1.0\"?><NonRealTimeMeta><Device manufacturer=\"Invented\" modelName=\"Camera $1\"/><Lens modelName=\"Lens $1\"/><Item name=\"CaptureGammaEquation\" value=\"$2\"/></NonRealTimeMeta>" > $T/sc/C0001M01.XML }
sc() { out=$(scan --paths-file $T/sc.txt --cache $T/scc --tier 1 2>/dev/null) }
cam() { echo "$out" | field '[m["cached"],m["camera"],m["lens"],m["gamma"]]' "m.get('tier')==0" }
thumb1() { echo "$out" | field 'm["thumb"]' "m.get('tier')==1" }
sc; ok "no sidecar" "$(cam)" '[false, null, null, null]'
side A rec709; sc; ok "a sidecar added after the first scan is read" "$(cam)" '[false, "Invented Camera A", "Lens A", "rec709"]'
first=$(thumb1)
sc; ok "  then remembered" "$(cam)" '[true, "Invented Camera A", "Lens A", "rec709"]'
side B s-log3-cine; sc; ok "a changed sidecar is read again" "$(cam)" '[false, "Invented Camera B", "Lens B", "s-log3-cine"]'
ok "  with a new thumbnail" "$(test -n "$first" && test "$(thumb1)" != "$first" && test -s "$(thumb1 | tr -d '"')" && echo yes)" yes
touch -t 202001010101 $T/sc/C0001M01.XML; sc; ok "a sidecar touched, same size, is read again" "$(cam | cut -c1-6)" '[false'
rm $T/sc/C0001M01.XML; sc; ok "a removed sidecar is noticed" "$(cam)" '[false, null, null, null]'

# ---- every date carries its zone, Z or an offset, so the panel can show local time. A time with no zone is passed over.
D=(ffmpeg -v error -nostdin -y -f lavfi -i testsrc2=s=320x180:r=25:d=1 -c:v libx264 -pix_fmt yuv420p)
mkdir $T/dt
limit 60 $D -movflags use_metadata_tags -metadata com.apple.quicktime.creationdate=2023-11-02T16:45:07+0100 -metadata creation_time=2023-11-02T15:45:07Z $T/dt/keys.mov || exit 1
limit 60 $D -movflags use_metadata_tags -metadata "com.apple.quicktime.creationdate=2023-11-02 16:45:07" -metadata creation_time=2023-11-02T15:45:07Z $T/dt/nozone.mov || exit 1
limit 60 $D -metadata date=2024-05-01T10:00:00-0400 $T/dt/day.mov || exit 1
limit 60 $D -metadata creation_time=2023-11-02T15:45:07.250000Z -movflags frag_keyframe+empty_moov $T/dt/frag.mp4 || exit 1
limit 60 $D -metadata creation_time=2023-11-02T15:45:07Z $T/dt/C0001.MP4 || exit 1
print -r -- '<?xml version="1.0"?><NonRealTimeMeta><CreationDate value="2025-12-12T19:03:06+01:00"/></NonRealTimeMeta>' > $T/dt/C0001M01.XML
limit 60 $D -metadata creation_time=2023-11-02T15:45:07Z $T/dt/C0002.MP4 || exit 1
print -r -- '<?xml version="1.0"?><NonRealTimeMeta><CreationDate value="2025-12-12 19:03:06"/></NonRealTimeMeta>' > $T/dt/C0002M01.XML
print -l $T/dt/* | grep -v XML > $T/dt.txt
out=$(scan --paths-file $T/dt.txt --cache $T/dtc --tier 0 2>/dev/null)
date0() { echo "$out" | field 'm["createdAt"]' "m.get('tier')==0 and m['path'].endswith('$1')" }
ok "an iPhone-style +0100 becomes +01:00" "$(date0 keys.mov)" '"2023-11-02T16:45:07+01:00"'
ok "a camera time with no zone gives way to the container's UTC" "$(date0 nozone.mov)" '"2023-11-02T15:45:07Z"'
ok "a -0400 in the date atom becomes -04:00" "$(date0 day.mov)" '"2024-05-01T10:00:00-04:00"'
ok "through ffprobe, fractions go and Z stays" "$(date0 frag.mp4)" '"2023-11-02T15:45:07Z"'
ok "a Sony sidecar's offset is kept" "$(date0 C0001.MP4)" '"2025-12-12T19:03:06+01:00"'
ok "a sidecar time with no zone gives way to the container" "$(date0 C0002.MP4)" '"2023-11-02T15:45:07Z"'
ok "every date has a zone" "$(echo "$out" | python3 -c '
import sys,json,re
d=[m.get("createdAt") for m in map(json.loads,sys.stdin) if m.get("tier")==0]
print(len(d), all(re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)", x) for x in d))')" '6 True'

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
  out=$(forced $mode --cache $T/f$mode --no-thumbs --tier 1 2>$T/f$mode.err); ok "forced $mode failure exits 0" $? 0
  ok "  240 clips keep Tier 0" "$(echo "$out" | grep -c '"tier":0.*"bitDepth":10,"chroma":"422"')" 240
  ok "  240 clips get null Tier 1 and a reason" "$(echo "$out" | grep '"tier":1' | grep '"luma":null' | grep -c '"reason":"This Mac')" 240
  ok "  done says degraded" "$(echo "$out" | tail -1 | field 'm["clips"],m["failed"],m["degraded"]' 'True')" '[240, 0, 240]'
  tries=$(grep -oE 'vt-refused=[0-9]+' $T/f$mode.err | cut -d= -f2)
  at_most "  attempts stay bounded, of 240 clips" ${tries:-999} 18
  at_most "  wall ms" "$(echo "$out" | tail -1 | field 'm["wallMs"]' 'True')" 3000
done
ok "reason names the format" "$(forced open --cache $T/f3 --no-thumbs --tier 1 2>/dev/null | grep -c 'no decoder for H.264 10-bit 4:2:2')" 240

# The same clips with ffmpeg there take the slow route and get real numbers.
print -l $T/x/a{1..8}.mov > $T/some.txt
out=$(ENGINE_TEST_DECODER=open limit 60 $B scan --paths-file $T/some.txt --cache $T/f4 2>/dev/null)
ok "decoder missing, ffmpeg fills in" "$(echo "$out" | grep -c '"sharpness":[0-9]')" 8
ok "  and no reason is given" "$(echo "$out" | grep -c '"reason"')" 0
ok "  and thumbnails are written" "$(echo "$out" | grep -c '"thumb":"/')" 8

# Stopping must take running ffmpegs with it. The long list only keeps it busy until the stop arrives.
for i in {1..10}; do cat $T/many.txt; done > $T/lots.txt
ENGINE_TEST_DECODER=open $B scan --paths-file $T/lots.txt --cache $T/f5 --no-thumbs --tier 1 >/dev/null 2>&1 &
pid=$!; seen=no
for i in {1..200}; do if pgrep -f "ffmpeg.*$T" >/dev/null; then seen=yes; break; fi; done
kill -TERM $pid; wait $pid; sleep 0.2
ok "ffmpeg was running when stopped" $seen yes
ok "SIGTERM leaves no ffmpeg behind" "$(pgrep -f "ffmpeg.*$T" | wc -l | tr -d ' ')" 0

# ---- Tier 2: what's in the clip, all worked out on this Mac
T2=(-f lavfi -i "testsrc2=s=640x360:r=25:d=2" -f lavfi -i "sine=f=440:r=48000:d=2")
mkdir $T/u
limit 60 $G -c:v libx264 -pix_fmt yuv420p -an $T/u/noaudio.mp4 || exit 1
for name in red green blue gray; do
  limit 60 ffmpeg -v error -nostdin -y -f lavfi -i "color=c=${name}:s=320x180:r=25:d=1" -c:v libx264 -pix_fmt yuv420p -an $T/u/$name.mp4 || exit 1
done
for i in 1 2; do cp $T/hevc.mp4 $T/u/take$i.mp4; done
limit 60 ffmpeg -v error -nostdin -y $T2 -c:v libx264 -pix_fmt yuv420p -g 5 -c:a aac -shortest $T/u/gop.mp4 || exit 1
print -l $T/s1.mp4 $T/u/noaudio.mp4 $T/u/{red,green,blue,gray}.mp4 $T/u/take{1,2}.mp4 $T/u/gop.mp4 > $T/t2.txt
out=$(scan --paths-file $T/t2.txt --cache $T/t2c 2>/dev/null); ok "tier 2 is the default, one line per clip" "$(echo "$out" | grep -c '"tier":2')" 9
ok "all lines are JSON with tier 2" "$(echo "$out" | python3 -c 'import sys,json; print(all(json.loads(l) for l in sys.stdin))')" True
want() { echo "$out" | field "$2" "m.get('tier')==2 and m['path'].endswith('$1')" }
ok "three moments" "$(want gop.mp4 'm["moments"]')" 3
ok "one thumb from tier 1" "$(echo "$out" | field 'bool(m["thumb"])' "m.get('tier')==1 and m['path'].endswith('s1.mp4')")" true
ok "every contract field is there" "$(want s1.mp4 'sorted(m)==sorted(["type","tier","path","cached","ms","moments","people","faces","shotSize","labels","text","sounds","speech","music","iso","shutterS","aperture","shake","colorHue","colorChroma","colorLight","colorName","palette"])')" true
ok "no audio track gives null sounds" "$(want noaudio.mp4 '[m["sounds"],m["speech"],m["music"]]')" '[null, null, null]'
ok "a tone isn't speech" "$(want s1.mp4 'm["speech"]')" false
ok "no rtmd track gives null camera values" "$(want s1.mp4 '[m["iso"],m["shutterS"],m["aperture"],m["shake"]]')" '[null, null, null, null]'
ok "nobody in a test card" "$(want s1.mp4 '[m["faces"],m["shotSize"]]')" '[0, null]'
ok "red reads red" "$(want red.mp4 'm["colorName"]')" '"red"'
ok "green reads green" "$(want green.mp4 'm["colorName"]')" '"green"'
ok "blue reads blue" "$(want blue.mp4 'm["colorName"]')" '"blue"'
ok "grey reads neutral, with no hue" "$(want gray.mp4 '[m["colorName"],m["colorHue"]]')" '["neutral", null]'
ok "a palette of hex colours" "$(want blue.mp4 'all(len(c)==7 and c[0]=="#" for c in m["palette"]) and 1<=len(m["palette"])<=5')" true
ok "one groups line, after tier 2, before done" "$(echo "$out" | python3 -c '
import sys,json
t=[json.loads(l)["type"] for l in sys.stdin]
print(t.count("groups")==1 and t[-1]=="done" and t[-2]=="groups")')" True
ok "identical takes are grouped" "$(echo "$out" | field 'any(sum(p.endswith(("take1.mp4","take2.mp4")) for p in g["paths"])==2 for g in m["groups"])' 'm["type"]=="groups"')" true
ok "solid colours aren't" "$(echo "$out" | field 'any(p.endswith(("red.mp4","green.mp4","blue.mp4")) for g in m["groups"] for p in g["paths"])' 'm["type"]=="groups"')" false
again=$(scan --paths-file $T/t2.txt --cache $T/t2c 2>/dev/null)
ok "rerun comes from the cache" "$(echo "$again" | tail -1 | grep -c '"cached":9')" 1
ok "rerun repeats the fields" "$(echo "$again" | grep '"tier":2' | sed 's/.*"ms":[0-9.]*,//' | sort | shasum)" "$(echo "$out" | grep '"tier":2' | sed 's/.*"ms":[0-9.]*,//' | sort | shasum)"
ok "rerun repeats the groups" "$(echo "$again" | grep '"type":"groups"')" "$(echo "$out" | grep '"type":"groups"')"
print -n 'not a record' >> $T/t2c/prints-v4.bin
rm -f $T/torn.out; scan --paths-file $T/t2.txt --cache $T/t2c > $T/torn.out 2>/dev/null
ok "a torn prints file costs nothing" "$(tail -1 $T/torn.out | grep -c '"cached":9')" 1
: > $T/t2c/prints-v4.bin
out2=$(scan --paths-file $T/t2.txt --cache $T/t2c 2>/dev/null)
ok "lost prints are worked out again" "$(echo "$out2" | grep '"type":"groups"' | grep -c take1)" 1
ok "tier 1 stops early" "$(scan --paths-file $T/t2.txt --cache $T/t2d --tier 1 2>/dev/null | grep -cE '"tier":2|"type":"groups"')" 0
ok "tier 2 follows tier 1 in the same cache" "$(scan --paths-file $T/t2.txt --cache $T/t2d 2>/dev/null | grep -c '"tier":2')" 9

# A clip with no picture keeps everything else, and isn't remembered as blank.
out=$(ENGINE_TEST_DECODER=open ENGINE_TEST_NO_FFMPEG=1 limit 60 $B scan --paths-file $T/nd.txt --cache $T/n6 2>/dev/null)
ok "no picture: picture fields are null" "$(echo "$out" | field '[m["moments"],m["people"],m["faces"],m["shotSize"],m["labels"],m["text"],m["colorName"],m["palette"]]' 'm.get("tier")==2')" '[0, null, null, null, null, null, null, null]'
ok "no picture: sound survives" "$(echo "$out" | field 'm["speech"]' 'm.get("tier")==2')" false
ok "no picture: an empty groups line" "$(echo "$out" | field 'm["groups"]' 'm["type"]=="groups"')" '[]'
ok "no picture isn't remembered" "$(scan --paths-file $T/nd.txt --cache $T/n6 2>/dev/null | field 'm["moments"]>0' 'm.get("tier")==2')" true
print $T/clip.mxf > $T/mxf.txt
out=$(scan --paths-file $T/mxf.txt --cache $T/n7 2>/dev/null)
ok "MXF through ffmpeg gets tier 2" "$(echo "$out" | field '[m["moments"]>=1,m["sounds"] is not None]' 'm.get("tier")==2')" '[true, true]'

# Sony's data track, made up here, and read back.
tests=$PWD/engine/tests
python3 $tests/rtmd_clip.py $T/s1.mp4 $T/u/sony.mp4 --iso 3200 --shutter-den 50 --code 53343 --gyro 40
python3 $tests/rtmd_clip.py $T/s1.mp4 $T/u/calm.mp4 --gyro 0.4 --no-log
print -l $T/u/sony.mp4 $T/u/calm.mp4 > $T/r.txt
out=$(scan --paths-file $T/r.txt --cache $T/r1 2>/dev/null)
ok "rtmd exposure" "$(want sony.mp4 '[m["iso"],m["shutterS"],m["aperture"]]')" '[3200, 0.02, 2.81]'
ok "no white balance field" "$(want sony.mp4 '"whiteBalanceK" in m')" false
ok "a hand reads shakier than a tripod" "$(echo "$out" | python3 -c '
import sys,json
s={m["path"][-8:]:m["shake"] for m in map(json.loads,sys.stdin) if m.get("tier")==2}
print(s["sony.mp4"]>0.5 and s["calm.mp4"]<0.3)')" True
if command -v exiftool >/dev/null; then
  ok "exiftool reads the same ISO" "$(exiftool -ee -n -s3 -ISO $T/u/sony.mp4 2>/dev/null | head -1)" 3200
  ok "exiftool reads the same shutter" "$(exiftool -ee -n -s3 -ExposureTime $T/u/sony.mp4 2>/dev/null | head -1)" 0.02
  ok "exiftool reads the same aperture" "$(printf %.2f "$(exiftool -ee -n -s3 -FNumber $T/u/sony.mp4 2>/dev/null | head -1)")" 2.81
else
  echo "SKIP exiftool cross-check: not installed"
fi

if command -v say >/dev/null; then
  say -o $T/words.aiff "The quick brown fox jumps over the lazy dog. We are talking now, and we will keep on talking for some time, because this is what speech sounds like." 2>/dev/null
  if [[ -s $T/words.aiff ]]; then
    limit 60 ffmpeg -v error -nostdin -y -f lavfi -i "testsrc2=s=320x180:r=25:d=8" -i $T/words.aiff -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest $T/u/talk.mp4
    print $T/u/talk.mp4 > $T/talk.txt
    out=$(scan --paths-file $T/talk.txt --cache $T/talkc 2>/dev/null)
    ok "speech is heard" "$(want talk.mp4 'm["speech"]')" true
    ok "sounds name it" "$(want talk.mp4 'any(s["name"]=="speech" for s in m["sounds"])')" true
  fi
fi

# ---- the grade Vision gets touches blue, green and red, and leaves alpha alone
ok "log grade maps all three colours" "$($B debug grade 10 20 30 255 | python3 -c 'import sys; b,g,r,a=map(int,sys.stdin.read().split()); print(b!=10 and g!=20 and r!=30 and a==255)')" True

# ---- nothing can stop a scan from ending: a stage that hangs costs its clip, not the scan
# 5 s, not less: every scan is a new process, and loading Vision and the sound model cold can take over 2 s on a busy Mac.
# `ends` checks the end of a scan: exactly one done, last, and with tier 2 exactly one groups line just before it.
ends() { python3 -c 'import sys,json; t=[json.loads(l)["type"] for l in sys.stdin]; print(bool(t) and t[-1]=="done" and t.count("done")==1 and (sys.argv[1]=="0" or (t.count("groups")==1 and t[-2]=="groups")))' ${1:-1} }
cp $T/u/gop.mp4 $T/u/hang.mp4
print -l $T/u/hang.mp4 $T/u/gop.mp4 > $T/hang.txt
for stage in tier0 tier1 vision sound middle; do
  t0=$(python3 -c 'import time;print(time.time())')
  out=$(ENGINE_TEST_HANG=$stage ENGINE_TEST_DEADLINE=5 limit 60 $B scan --paths-file $T/hang.txt --cache $T/h$stage 2>/dev/null); rc=$?
  secs=$(python3 -c "import time;print(int(time.time()-$t0))")
  ok "a hang in $stage: exit 0" $rc 0
  ok "  groups and done arrive" "$(echo "$out" | ends)" True
  at_most "  seconds" $secs 20
  ok "  the other clip is untouched" "$(want gop.mp4 'm["moments"]')" 3
done
out=$(ENGINE_TEST_HANG=tier0 ENGINE_TEST_DEADLINE=2 limit 60 $B scan --paths-file $T/hang.txt --cache $T/hx0 2>/dev/null)
ok "a hang in tier 0 gives an error line" "$(echo "$out" | grep -c '"type":"error".*took too long')" 1
ok "  and done arrives" "$(echo "$out" | ends)" True
out=$(ENGINE_TEST_HANG=vision ENGINE_TEST_DEADLINE=2 limit 60 $B scan --paths-file $T/hang.txt --cache $T/hx1 2>/dev/null)
ok "a hang in Vision: blank tier 2 with a reason" "$(want hang.mp4 '[m["moments"],m["labels"],"took too long" in m["reason"]]')" '[0, null, true]'
ok "  and done arrives" "$(echo "$out" | ends)" True
out=$(scan --paths-file $T/hang.txt --cache $T/hx1 2>/dev/null)
ok "  and it isn't remembered" "$(echo "$out" | grep '"tier":2' | grep -c '"cached":true')" 1
ok "  and done arrives the time after" "$(echo "$out" | ends)" True
out=$(ENGINE_TEST_HANG=tier1 ENGINE_TEST_DEADLINE=2 limit 60 $B scan --paths-file $T/hang.txt --cache $T/hx2 2>/dev/null)
ok "a hang in tier 1: blank tier 1 with a reason" "$(echo "$out" | field '[m["sharpness"],"took too long" in m["reason"]]' "m.get('tier')==1 and m['path'].endswith('hang.mp4')")" '[null, true]'
ok "  and done arrives" "$(echo "$out" | ends)" True
out=$(ENGINE_TEST_HANG=middle ENGINE_TEST_DEADLINE=2 limit 60 $B scan --paths-file $T/hang.txt --cache $T/hx3 2>/dev/null)
ok "a hang beside tier 1 costs nothing: the clip is looked at again" "$(want hang.mp4 'm["moments"]>=1')" true
ok "  and done arrives" "$(echo "$out" | ends)" True
ENGINE_TEST_HANG=vision ENGINE_TEST_DEADLINE=600 $B scan --paths-file $T/hang.txt --cache $T/hx4 2>/dev/null | head -1 >/dev/null
sleep 2
ok "a closed stdout ends a stuck scan without another write" "$(pgrep -f "cache $T/hx4" | wc -l | tr -d ' ')" 0

# A clip whose first look at a format hangs in Vision mustn't keep that format's other clips waiting: the format is proven
# once a frame decodes, whatever happens to the frame after. One worker makes the hung clip go first; the default races it.
mkdir $T/gate; cp $T/u/gop.mp4 $T/gate/a-hang.mp4; for i in 1 2 3 4; do cp $T/u/gop.mp4 $T/gate/b$i.mp4; done
print -l $T/gate/a-hang.mp4 $T/gate/b{1..4}.mp4 > $T/gate.txt
for w in 1 default; do
  extra=(); [[ $w == 1 ]] && extra=(--workers 1)
  out=$(ENGINE_TEST_HANG=vision ENGINE_TEST_DEADLINE=5 limit 60 $B scan --paths-file $T/gate.txt --cache $T/gate$w $extra 2>/dev/null)
  ok "a first-format Vision hang, workers $w: the four clips behind it get three moments" "$(echo "$out" | field 'm["moments"]' "m.get('tier')==2 and m['path'].rsplit('/',1)[-1].startswith('b')" | tr '\n' ' ')" '3 3 3 3 '
  ok "  the hung clip is blank, with a reason" "$(want a-hang.mp4 '[m["moments"],"took too long" in m["reason"]]')" '[0, true]'
  ok "  groups and done arrive" "$(echo "$out" | ends)" True
done

# Every middle-frame thread stuck, with work still queued behind them: the queue is dropped and Tier 2 does it itself.
mkdir $T/mq; for i in {10..21}; do ln $T/u/gop.mp4 $T/mq/hang$i.mp4; done; print -l $T/mq/*.mp4 > $T/mq.txt
out=$(ENGINE_TEST_HANG=middle ENGINE_TEST_DEADLINE=1 limit 40 $B scan --paths-file $T/mq.txt --cache $T/mqc --workers 2 2>/dev/null)
ok "every middle thread stuck, work still queued: twelve tier 2 lines" "$(echo "$out" | grep -c '"tier":2')" 12
ok "  each looked at again" "$(echo "$out" | field 'm["moments"]' "m.get('tier')==2" | sort -u)" 3
ok "  groups and done arrive" "$(echo "$out" | ends)" True

# More stuck clips than spare threads: once none is left to replace them, the rest are settled with a reason, so done arrives.
# Lines that settle a clip in a tier: errors for tier 0, clip lines otherwise.
settled() { python3 -c 'import sys,json; t=int(sys.argv[1]); r=[json.loads(l) for l in sys.stdin]; print(sum(1 for m in r if (m["type"]=="error" if t==0 else m.get("tier")==t)))' $1 }
mkdir $T/sp; for i in {100..165}; do ln $T/u/gop.mp4 $T/sp/hang$i.mp4; done; print -l $T/sp/*.mp4 > $T/sp.txt
for stage in tier0 tier1 vision; do
  tier=2; [[ $stage == tier0 ]] && tier=0; [[ $stage == tier1 ]] && tier=1
  grouped=0; [[ $tier == 2 ]] && grouped=1
  out=$(ENGINE_TEST_HANG=$stage ENGINE_TEST_DEADLINE=0.05 limit 60 $B scan --paths-file $T/sp.txt --cache $T/sp$stage --workers 1 --tier $tier --no-thumbs 2>/dev/null)
  ok "66 clips stuck in $stage on one worker: every clip settled" "$(echo "$out" | settled $tier)" 66
  ok "  the one no thread was left for says why" "$(echo "$out" | grep -c 'kept getting stuck')" 1
  ok "  done arrives" "$(echo "$out" | ends $grouped)" True
done

# ---- a Vision request that fails gives null for its field, never 0 or [], and the clip isn't remembered
# The test asks Vision for a request revision no Mac has, which fails that request for real. One worker, so the healthy clips
# after it run on the same requests, which must work again. Vision cancels the rest of a perform when one fails, so only the
# failed request's own fields are checked.
mkdir $T/vf; cp $T/u/gop.mp4 $T/vf/vfail-gop.mp4; cp $T/u/gop.mp4 $T/vf/okgop.mp4
if command -v osascript >/dev/null; then
  cat > $T/sign.js <<'JS'
ObjC.import('AppKit');
function run(argv) {
  var img = $.NSImage.alloc.initWithSize($.NSMakeSize(640, 360));
  img.lockFocus;
  $.NSColor.whiteColor.setFill; $.NSRectFill($.NSMakeRect(0, 0, 640, 360));
  var attrs = $.NSMutableDictionary.alloc.init;
  attrs.setObjectForKey($.NSFont.boldSystemFontOfSize(72), $.NSFontAttributeName);
  attrs.setObjectForKey($.NSColor.blackColor, $.NSForegroundColorAttributeName);
  $(argv[1]).drawAtPointWithAttributes($.NSMakePoint(60, 140), attrs);
  img.unlockFocus;
  $.NSBitmapImageRep.imageRepWithData(img.TIFFRepresentation).representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(argv[0], true);
}
JS
  limit 30 osascript -l JavaScript $T/sign.js $T/sign.png "OPEN DAILY" && \
    limit 60 ffmpeg -v error -nostdin -y -loop 1 -i $T/sign.png -t 2 -r 25 -vf scale=640:360 -c:v libx264 -pix_fmt yuv420p -g 5 $T/vf/vfail-sign.mp4 && \
    cp $T/vf/vfail-sign.mp4 $T/vf/oksign.mp4
fi
print -l $T/vf/vfail-gop.mp4 $T/vf/okgop.mp4 > $T/vf.txt
[[ -s $T/vf/oksign.mp4 ]] && print -l $T/vf/vfail-sign.mp4 $T/vf/oksign.mp4 >> $T/vf.txt || echo "SKIP OCR failure check: no osascript to draw a sign"
healthy='[type(m["labels"]) is list, type(m["faces"]) is int, type(m["people"]) is int, type(m["text"]) is list]'
for req in classify:labels faces:faces people:people boxes:text text:text; do
  name=${req%%:*}; fields=${req#*:}
  clip=vfail-gop.mp4; [[ $name == text ]] && clip=vfail-sign.mp4
  [[ $clip == vfail-sign.mp4 && ! -s $T/vf/oksign.mp4 ]] && continue
  out=$(ENGINE_TEST_VISION_FAIL=$name limit 60 $B scan --paths-file $T/vf.txt --cache $T/vf$name --workers 1 2>/dev/null)
  ok "Vision's $name request fails: $fields is null" "$(want $clip "[m[\"$fields\"], m[\"moments\"]]")" '[null, 3]'
  [[ $fields == faces || $fields == people ]] && ok "  and so is the shot size" "$(want $clip 'm["shotSize"]')" null
  ok "  the clip after it, on the same worker, is whole" "$(want okgop.mp4 "$healthy")" '[true, true, true, true]'
  [[ -s $T/vf/oksign.mp4 ]] && ok "  and reads its sign" "$(want oksign.mp4 'm["text"]')" '["OPEN", "DAILY"]'
  ok "  done arrives" "$(echo "$out" | ends)" True
  out=$(scan --paths-file $T/vf.txt --cache $T/vf$name 2>/dev/null)
  ok "  the unknown isn't remembered, the whole one is" "$(want $clip 'm["cached"]'):$(want okgop.mp4 'm["cached"]')" false:true
done

# ---- log footage is converted only when the file says S-Log3 with S-Gamut3.Cine. Anything else keeps its colours as recorded,
# with a note. Each variant is the same pixels: one that isn't converted must match the clip that claims nothing.
mkdir $T/lg
for v in base:: cine:s-log3-cine:s-gamut3-cine slog2:s-log2:s-gamut sg3:s-log3:s-gamut3 hlg:hlg:rec2020 r709:rec709:rec709; do
  name=${v%%:*}; rest=${v#*:}; mkdir $T/lg/$name; cp $T/u/gop.mp4 $T/lg/$name/C0001.MP4
  [[ $name != base ]] && print -r -- "<?xml version=\"1.0\"?><NonRealTimeMeta><Item name=\"CaptureGammaEquation\" value=\"${rest%%:*}\"/><Item name=\"CaptureColorPrimaries\" value=\"${rest#*:}\"/></NonRealTimeMeta>" > $T/lg/$name/C0001M01.XML
done
python3 $tests/rtmd_clip.py $T/u/gop.mp4 $T/lg/rtmd-plain.mp4 --no-log
python3 $tests/rtmd_clip.py $T/u/gop.mp4 $T/lg/rtmd-cine.mp4
python3 $tests/rtmd_clip.py $T/u/gop.mp4 $T/lg/rtmd-other.mp4 --gamut other
print -l $T/lg/*/C0001.MP4 $T/lg/rtmd-*.mp4 > $T/lg.txt
scan --paths-file $T/lg.txt --cache $T/lgc 2>/dev/null > $T/lg.out
# For each clip: [colour as the base (or plain rtmd) clip, thumbnail as the base, the note's first words]
graded() { python3 -c '
import sys,json,hashlib
rows=[json.loads(l) for l in open(sys.argv[1])]
def get(key, t, f): return next(m.get(f) for m in rows if m.get("tier")==t and key in m["path"])
def look(key): return (get(key,2,"palette"), get(key,2,"colorHue"), hashlib.sha1(open(get(key,1,"thumb"),"rb").read()).hexdigest())
key, ref = sys.argv[2], sys.argv[3]
a, b = look(key), look(ref); note = get(key,0,"colorNote")
print(json.dumps([a[:2]==b[:2], a[2]==b[2], " ".join(note.split()[:5]) if note else None]))' $T/lg.out $1 $2 }
ok "S-Log3 with S-Gamut3.Cine is converted, with no note" "$(graded /cine/ /base/)" '[false, false, null]'
ok "S-Log2 keeps its colours, and says so" "$(graded /slog2/ /base/)" '[true, true, "Recorded in S-Log2, which Select"]'
ok "S-Log3 with S-Gamut3 keeps its colours, and says so" "$(graded /sg3/ /base/)" '[true, true, "Recorded in S-Log3 with a"]'
ok "HLG keeps its colours, and says so" "$(graded /hlg/ /base/)" '[true, true, "Recorded in HLG, which Select"]'
ok "Rec. 709 needs nothing said" "$(graded /r709/ /base/)" '[true, true, null]'
ok "Sony's data track, S-Log3 with S-Gamut3.Cine, is converted" "$(graded rtmd-cine rtmd-plain)" '[false, false, null]'
ok "Sony's data track, S-Log3 with another gamut, isn't" "$(graded rtmd-other rtmd-plain)" '[true, true, "Recorded in S-Log3 with a"]'

# ---- prints from another Vision revision are never mixed
ENGINE_TEST_PRINT_REVISION=1 limit 120 $B scan --paths-file $T/t2.txt --cache $T/rv >/dev/null 2>&1
out=$(scan --paths-file $T/t2.txt --cache $T/rv 2>/dev/null)
ok "old-revision prints are worked out again" "$(echo "$out" | grep '"tier":2' | grep -c '"cached":false')" 9
ok "  and still group" "$(echo "$out" | field 'any(sum(p.endswith(("take1.mp4","take2.mp4")) for p in g["paths"])==2 for g in m["groups"])' 'm["type"]=="groups"')" true
ok "  then come from the cache" "$(scan --paths-file $T/t2.txt --cache $T/rv 2>/dev/null | grep '"tier":2' | grep -c '"cached":true')" 9

# ---- only clips in the same folder are compared
mkdir -p $T/fa $T/fb; cp $T/hevc.mp4 $T/fa/same.mp4; cp $T/hevc.mp4 $T/fb/same.mp4; print -l $T/fa/same.mp4 $T/fb/same.mp4 > $T/folders.txt
ok "the same shot in two folders isn't grouped" "$(scan --paths-file $T/folders.txt --cache $T/fo 2>/dev/null | field 'm["groups"]' 'm["type"]=="groups"')" '[]'

# ---- sound below 16 kHz is heard at the right speed
if [[ -s $T/words.aiff ]]; then
  for rate in 8000 11025; do
    limit 60 ffmpeg -v error -nostdin -y -f lavfi -i "testsrc2=s=320x180:r=25:d=8" -i $T/words.aiff -c:v libx264 -pix_fmt yuv420p -c:a pcm_s16le -ar $rate -shortest $T/u/talk$rate.mov
    print $T/u/talk$rate.mov > $T/talk$rate.txt
    out=$(scan --paths-file $T/talk$rate.txt --cache $T/tk$rate 2>/dev/null)
    ok "speech at $rate Hz is heard" "$(want talk$rate.mov 'm["speech"]')" true
  done
fi

# ---- every audio track is heard: a silent first track doesn't make a clip silent, and a lav on track two is listened to
A=(ffmpeg -v error -nostdin -y -f lavfi -i testsrc2=s=320x180:r=25:d=6 -f lavfi -i anullsrc=r=48000:cl=mono)
mkdir $T/au
limit 60 $A -f lavfi -i sine=f=440:r=48000:d=6 -map 0:v -map 1:a -map 2:a -c:v libx264 -pix_fmt yuv420p -c:a pcm_s16le -t 6 $T/au/tone2.mov || exit 1
limit 60 $A -f lavfi -i sine=f=440:r=48000:d=6 -map 0:v -map 1:a -map 2:a -c:v libx264 -pix_fmt yuv420p -c:a:0 pcm_s16le -c:a:1 ac3 -t 6 $T/au/ac3two.mov || exit 1
limit 60 $A -f lavfi -i sine=f=440:r=48000:d=6 -map 0:v -map 1:a -map 2:a -c:v mpeg2video -pix_fmt yuv422p -c:a pcm_s16le -t 6 $T/au/tone2.mxf || exit 1
print -l $T/au/tone2.mov $T/au/ac3two.mov $T/au/tone2.mxf > $T/au.txt
out=$(scan --paths-file $T/au.txt --cache $T/auc 2>/dev/null)
lvl() { echo "$out" | field '[m["silent"], m["audioDb"] is not None and m["audioDb"] > -30]' "m.get('tier')==1 and m['path'].endswith('$1')" }
ok "a silent first track and a tone on the second isn't silent" "$(lvl tone2.mov)" '[false, true]'
ok "  nor when only ffmpeg reads the second track" "$(lvl ac3two.mov)" '[false, true]'
ok "  nor through ffmpeg, MXF with two tracks" "$(lvl tone2.mxf)" '[false, true]'
ok "  and tier 2 has something to listen to" "$(echo "$out" | field 'm["sounds"] is not None' "m.get('tier')==2" | sort -u)" true
out=$(export_no --paths-file $T/au.txt --cache $T/auc2 2>/dev/null)
ok "a track nobody here can read leaves the level unknown, not silent" "$(echo "$out" | field '[m["audioDb"], m["silent"]]' "m.get('tier')==1 and m['path'].endswith('ac3two.mov')")" '[null, null]'
ok "  and the sounds unknown, not none" "$(echo "$out" | field 'm["sounds"]' "m.get('tier')==2 and m['path'].endswith('ac3two.mov')")" null
if [[ -s $T/words.aiff ]]; then
  limit 60 $A -i $T/words.aiff -map 0:v -map 1:a -map 2:a -c:v libx264 -pix_fmt yuv420p -c:a pcm_s16le -ar 48000 -t 6 $T/au/lav2.mov || exit 1
  # Left and right in opposite polarity: a plain mix of the two is silence.
  limit 60 ffmpeg -v error -nostdin -y -f lavfi -i testsrc2=s=320x180:r=25:d=6 -i $T/words.aiff -map 0:v -map 1:a -af 'pan=stereo|c0=c0|c1=-1*c0' \
      -c:v libx264 -pix_fmt yuv420p -c:a pcm_s16le -ar 48000 -t 6 $T/au/flip.mov || exit 1
  limit 60 ffmpeg -v error -nostdin -y -f lavfi -i testsrc2=s=320x180:r=25:d=6 -i $T/words.aiff -map 0:v -map 1:a -af 'pan=stereo|c0=c0|c1=-1*c0' \
      -c:v mpeg2video -pix_fmt yuv422p -c:a pcm_s16le -ar 48000 -t 6 $T/au/flip.mxf || exit 1
  # Speech on the left and a tone 14 dB down on the right, like a camera mic under a lav: both stay in the mix.
  limit 60 ffmpeg -v error -nostdin -y -f lavfi -i testsrc2=s=320x180:r=25:d=6 -i $T/words.aiff -f lavfi -i "sine=f=440:r=48000:d=6,volume=0.35" \
      -filter_complex "[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,apad[s];[2:a]aformat=sample_fmts=fltp:channel_layouts=mono[t];[s][t]join=inputs=2:channel_layout=stereo[a]" \
      -map 0:v -map "[a]" -c:v libx264 -pix_fmt yuv420p -c:a pcm_s16le -t 6 $T/au/under.mov || exit 1
  print -l $T/au/lav2.mov $T/au/flip.mov $T/au/flip.mxf $T/au/under.mov > $T/au2.txt
  out=$(scan --paths-file $T/au2.txt --cache $T/auc3 2>/dev/null)
  ok "speech on the second track is heard" "$(want lav2.mov 'm["speech"]')" true
  ok "speech in opposite polarity on two channels is heard" "$(want flip.mov 'm["speech"]')" true
  ok "  and through ffmpeg" "$(want flip.mxf 'm["speech"]')" true
  ok "a quieter channel with its own sound stays in the mix" "$(want under.mov '[m["speech"], any(s["name"] in ("beep","bell","music","tuning fork") for s in m["sounds"])]')" '[true, true]'
fi

# ---- one scan at a time writes a cache. A second one waits a moment, then reads it and writes nothing.
print $T/u/hang.mp4 > $T/lockA.txt
# Started directly, so $! is the engine itself. Its 30 s deadline ends it anyway, and cleanup stops anything left.
ENGINE_TEST_HANG=vision ENGINE_TEST_DEADLINE=30 $B scan --paths-file $T/lockA.txt --cache $T/lk > $T/lockA.out 2>/dev/null &
lockA=$!
for i in {1..100}; do grep -q '"tier":1' $T/lockA.out 2>/dev/null && break; sleep 0.1; done; sleep 0.5
before=$(cat $T/lk/index-v4.tsv $T/lk/prints-v4.bin 2>/dev/null | shasum; ls $T/lk/thumbs | wc -l)
out=$(scan --paths-file $T/t2.txt --cache $T/lk 2>$T/lockB.err)
ok "a second scan on a cache in use says so" "$(grep -c 'another scan is using' $T/lockB.err)" 1
ok "  and still gives every result" "$(echo "$out" | grep -c '"tier":2')" 9
ok "  and still groups" "$(echo "$out" | field 'any(sum(p.endswith(("take1.mp4","take2.mp4")) for p in g["paths"])==2 for g in m["groups"])' 'm["type"]=="groups"')" true
ok "  and done arrives" "$(echo "$out" | ends)" True
ok "  and writes nothing to the cache" "$(cat $T/lk/index-v4.tsv $T/lk/prints-v4.bin 2>/dev/null | shasum; ls $T/lk/thumbs | wc -l)" "$before"
kill $lockA 2>/dev/null; wait $lockA 2>/dev/null
out=$(scan --paths-file $T/t2.txt --cache $T/lk 2>$T/lockC.err)
ok "once the first has gone, the cache is written again" "$(grep -c 'another scan' $T/lockC.err):$(scan --paths-file $T/t2.txt --cache $T/lk 2>/dev/null | grep '"tier":2' | grep -c '"cached":true')" 0:9

# ---- the cache stays small: superseded prints go, orphaned thumbnails go, and a size cap drops the oldest first
mkdir -p $T/k; for i in 1 2 3; do cp $T/u/gop.mp4 $T/k/c$i.mp4; done; print -l $T/k/*.mp4 > $T/k.txt
scan --paths-file $T/k.txt --cache $T/kc >/dev/null 2>&1
one=$(stat -f %z $T/kc/prints-v4.bin)
for n in {1..8}; do touch $T/k/*.mp4; scan --paths-file $T/k.txt --cache $T/kc >/dev/null 2>&1; done
at_most "prints after eight touched rescans, against one scan, in tenths" $(( $(stat -f %z $T/kc/prints-v4.bin) * 10 / one )) 30
ok "thumbnails after eight touched rescans" "$(ls $T/kc/thumbs | wc -l | tr -d ' ')" 3
mkdir -p $T/ka $T/kb; for i in {1..40}; do ln $T/u/gop.mp4 $T/ka/a$i.mp4; ln $T/u/gop.mp4 $T/kb/b$i.mp4; done
print -l $T/ka/*.mp4 > $T/ka.txt; print -l $T/kb/*.mp4 > $T/kb.txt
scan --paths-file $T/ka.txt --cache $T/kcap --cache-limit-mb 1 >/dev/null 2>&1
ok "a scan never drops what it just used" "$(ls $T/kcap/thumbs | wc -l | tr -d ' ')" 40
scan --paths-file $T/kb.txt --cache $T/kcap --cache-limit-mb 1 >/dev/null 2>&1
ok "over the cap, the oldest clips go first" "$(scan --paths-file $T/ka.txt --cache $T/kcap2 --tier 0 2>/dev/null | tail -1 | grep -c '"cached":0'):$(scan --paths-file $T/kb.txt --cache $T/kcap --tier 0 2>/dev/null | tail -1 | grep -c '"cached":40')" 1:1
ok "  their thumbnails go with them" "$(ls $T/kcap/thumbs | wc -l | tr -d ' ')" 40

echo "$pass passed, $failn failed"
(( failn == 0 ))
