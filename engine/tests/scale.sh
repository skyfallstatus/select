#!/bin/zsh
# Runs the engine on 50,000 clips and reports time and peak memory. Needs no footage: 25 tiny generated clips are hard-linked
# 2,000 times each, into 200 folders of 250, so they take almost no disk. Vision's models are swapped for a stand-in that
# makes prints from the pixels, because 150,000 real looks would take an hour. Everything else is real: decoding, colour,
# the cache, the prints file, grouping and upkeep.
# Needs ffmpeg and 3 GB free. Stops itself after 15 minutes, or if its folder passes 2.5 GB.
#   engine/tests/scale.sh [clips]
cd "${0:A:h}/../.."
source ./product.conf
B=$PWD/engine/build/$ENGINE
N=${1:-50000}
[[ -x $B ]] || { echo "No engine at $B. Run scripts/build-engine.sh first."; exit 1 }
command -v ffmpeg >/dev/null || { echo "SKIP: ffmpeg makes the test clips and isn't installed."; exit 0 }
T=$(mktemp -d "${TMPDIR:-/tmp}/engine-scale.XXXXXX") || exit 1
free=$(df -k "$T" | tail -1 | awk '{print $4}')
(( free > 3 * 1024 * 1024 )) || { echo "Stopped: less than 3 GB free."; rm -rf $T; exit 1 }
LIMIT_KB=$(( 2500 * 1024 ))
cleanup() { [[ -n $WATCH ]] && kill $WATCH 2>/dev/null; pkill -f "$T" 2>/dev/null; [[ -n $SCALE_KEEP ]] && { mv $T/out.jsonl $T/err.txt $SCALE_KEEP/ 2>/dev/null; mv $T/cold.jsonl $SCALE_KEEP/ 2>/dev/null; du -sk $T/cache/* > $SCALE_KEEP/du.txt 2>/dev/null; cp $T/cache/prints-v3.bin $T/cache/index-v3.tsv $SCALE_KEEP/ 2>/dev/null; cp $T/coldprints.bin $SCALE_KEEP/ 2>/dev/null }; rm -rf "$T" }
trap cleanup EXIT
trap 'echo "Stopped: out of time, out of room, or interrupted."; exit 3' TERM INT
# Stops everything if the folder grows past its limit or the run passes 15 minutes.
( for s in {1..180}; do sleep 5; (( $(du -sk $T | cut -f1) > LIMIT_KB )) && { echo "Stopped: the test folder passed 2.5 GB." >&2; kill -TERM $$; exit; }; done; kill -TERM $$ ) &!
WATCH=$!

for k in {0..24}; do
  perl -e 'alarm 60; exec @ARGV' ffmpeg -v error -nostdin -y -f lavfi -i "testsrc2=s=160x90:r=25:d=$(( k + 2 ))" -ss $k \
    -c:v libx264 -pix_fmt yuv420p -g 5 -an $T/src$k.mp4 || exit 1
done
python3 -I - $T $N <<'P'
import os, sys
t, n = sys.argv[1], int(sys.argv[2])
paths = []
for i in range(n):
    folder = f'{t}/clips/f{i // 250:03d}'
    if i % 250 == 0:
        os.makedirs(folder, exist_ok=True)
    p = f'{folder}/c{i % 250:03d}.mp4'
    os.link(f'{t}/src{(i // 5) % 25}.mp4', p)        # runs of 5 identical clips
    paths.append(p)
open(f'{t}/list.txt', 'w').write('\n'.join(paths) + '\n')
P
run() {
  ENGINE_TEST_FAKE_VISION=1 /usr/bin/time -l $B scan --paths-file $T/list.txt --cache $T/cache > $T/out.jsonl 2> $T/err.txt
  echo "exit $?"
  python3 -I - $T <<'P'
import json, re, sys
t = sys.argv[1]
types = {}
groups = None
for line in open(f'{t}/out.jsonl'):
    m = json.loads(line)
    key = m['type'] + (str(m.get('tier')) if m['type'] == 'clip' else '')
    types[key] = types.get(key, 0) + 1
    if m['type'] == 'groups':
        groups = m['groups']
    if m['type'] == 'done':
        done = m
err = open(f'{t}/err.txt').read()
rss = int(re.search(r'(\d+)\s+maximum resident set size', err).group(1))
print('lines', dict(sorted(types.items())))
print('groups', len(groups), 'clips in them', sum(len(g['paths']) for g in groups), 'largest', max((len(g['paths']) for g in groups), default=0))
print('wall', done['wallMs'], 'ms, cached', done['cached'], ', peak memory', rss // (1 << 20), 'MB')
for l in err.splitlines():
    if re.search(r'phase|groups done', l): print(' ', l.strip())
P
}
echo "--- $N clips, cold"; run
echo "cache: $(du -sh $T/cache | cut -f1)"
cp $T/out.jsonl $T/cold.jsonl; cp $T/cache/prints-v3.bin $T/coldprints.bin
echo "--- $N clips, cached"; run
