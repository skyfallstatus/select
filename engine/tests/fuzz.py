#!/usr/bin/env python3
"""Damages tiny generated clips in moov and in sample data, scans them, and checks the engine survives.

Every clip must end up as a clip line or an error line, every line must be JSON, and the engine must
exit 0. It runs once with ffmpeg and once as if ffmpeg weren't there. Everything lives in a temp folder
that goes away afterwards, capped at 64 MB. Without ffmpeg there are no clips to make, so it skips.

    engine/tests/fuzz.py [--engine path] [--count 300]
"""
import argparse, json, os, random, re, shutil, struct, subprocess, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rtmd_clip

MAX_BYTES = 64 * 1024 * 1024
HERE = os.path.dirname(os.path.abspath(__file__))
conf = open(os.path.join(HERE, '..', '..', 'product.conf')).read()
ENGINE = re.search(r'^ENGINE=(.+)$', conf, re.M).group(1)
parser = argparse.ArgumentParser()
parser.add_argument('--engine', default=os.path.join(HERE, '..', 'build', ENGINE))
parser.add_argument('--count', type=int, default=300)
parser.add_argument('--seed', type=int, default=11)
parser.add_argument('--keep', help='leave the clips in this folder, to look at a failure')
args = parser.parse_args()

if not os.access(args.engine, os.X_OK):
    sys.exit(f'No engine at {args.engine}. Run scripts/build-engine.sh first.')
if not shutil.which('ffmpeg'):
    print('SKIP: ffmpeg makes the test clips and is not installed. brew install ffmpeg')
    sys.exit(0)

def moov_range(b):
    pos = 0
    while pos + 8 <= len(b):
        s, t = struct.unpack('>I4s', b[pos:pos + 8])
        hd = 8
        if s == 1:
            s = struct.unpack('>Q', b[pos + 8:pos + 16])[0]
            hd = 16
        if s == 0:
            s = len(b) - pos
        if s < hd:
            return None
        if t == b'moov':
            return pos, pos + s
        pos += s
    return None

def make_sources(folder):
    base = ['ffmpeg', '-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=1',
            '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=1']
    recipes = {
        'a.mp4': ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest'],
        'b.mov': ['-c:v', 'libx264', '-pix_fmt', 'yuv422p10le', '-profile:v', 'high422', '-g', '1', '-c:a', 'pcm_s16le', '-shortest'],
        'c.mp4': ['-c:v', 'libx265', '-tag:v', 'hvc1', '-x265-params', 'log-level=error', '-c:a', 'aac', '-shortest'],
        'd.mov': ['-c:v', 'prores_ks', '-profile:v', '0', '-c:a', 'pcm_s16le', '-shortest'],
    }
    made = []
    for name, opts in recipes.items():
        path = os.path.join(folder, name)
        subprocess.run(base + opts + [path], check=True, timeout=60)
        made.append(path)
    return made

def damage(sources, folder, count):
    random.seed(args.seed)
    listing, total = [], 0
    for i in range(count):
        p = sources[i % len(sources)]
        b = bytearray(open(p, 'rb').read())
        r = moov_range(b)
        kind = random.choice(['flip', 'flip', 'flip', 'zero', 'max', 'truncate', 'moovcut', 'keyframe'])
        if r:
            a, z = r
            if kind in ('flip', 'zero', 'max'):
                for _ in range(random.choice([1, 4, 16, 64, 256])):
                    k = random.randrange(a, z)
                    b[k] = {'flip': random.randrange(256), 'zero': 0, 'max': 255}[kind]
            elif kind == 'moovcut':
                b = b[:a + random.randrange(max(1, z - a))]
        if kind == 'truncate':
            b = b[:random.randrange(len(b))]
        if kind == 'keyframe':
            for _ in range(200):
                b[random.randrange(len(b))] = random.randrange(256)
        q = f'{folder}/f{i:04d}{os.path.splitext(p)[1]}'
        total += len(b)
        if total > MAX_BYTES:
            sys.exit(f'Stopped: the fuzz clips passed {MAX_BYTES} bytes.')
        open(q, 'wb').write(b)
        listing.append(q)
    for name, body in (('empty.mp4', b''), ('tiny.mp4', b'\x00\x00\x00\x08moov'), ('text.mov', b'hello world' * 100),
                       ('hugebox.mp4', struct.pack('>I4sQ', 1, b'moov', 2**62))):
        q = f'{folder}/{name}'
        open(q, 'wb').write(body)
        listing.append(q)
    return listing

def hostile_rtmd(sources, folder, count):
    """Real-looking clips with a data track built to break a parser that trusts it."""
    base = next(p for p in sources if p.endswith('.mp4'))
    data = open(base, 'rb').read()
    r = random.Random(args.seed + 12)
    listing = []
    for i in range(count):
        samples = [bytearray(rtmd_clip.sample(seed=j)) for j in range(r.choice([1, 2, 12, 40]))]
        kind = i % 9
        for s in samples:
            if kind == 0:                       # random damage anywhere
                for _ in range(r.choice([4, 64, 512])):
                    s[r.randrange(len(s))] = r.randrange(256)
            elif kind == 1:                     # a header length past the end
                s[0:2] = b'\xff\xff'
            elif kind == 2:                     # gyro claims more readings than exist
                at = s.find(b'\xe4\x3b')
                s[at + 4:at + 8] = struct.pack('>I', 0xffffffff)
            elif kind == 3:                     # every tag length a lie
                for at in range(0x1c, len(s) - 4, 7):
                    s[at + 2:at + 4] = b'\xff\xff'
            elif kind == 4:                     # a sample cut short
                del s[r.randrange(1, len(s)):]
            elif kind == 5:                     # scale of zero, NaN or infinity
                at = s.find(b'\xe4\x39')
                s[at + 4:at + 8] = r.choice([bytes(4), b'\x7f\xc0\x00\x00', b'\x7f\x80\x00\x00'])
            elif kind == 6:                     # shutter of 0/0, ISO of 0, wild f-number
                at = s.find(b'\x81\x09')
                s[at + 4:at + 12] = bytes(8)
                at = s.find(b'\x80\x00')
                s[at + 4:at + 6] = b'\xff\xff'
            elif kind == 7:                     # a tag of 0x8300 repeating, the one that descends
                s[0x1c:] = b'\x83\x00\x00\x00' * ((len(s) - 0x1c) // 4)
        out = rtmd_clip.add_track(data, [bytes(s) for s in samples], per_chunk=r.choice([1, 12, 64]))
        if kind == 8:                           # tables that point outside the file or claim absurd sizes
            b = bytearray(out)
            for name in (b'stsz', b'stco', b'stsc'):
                at = b.rfind(name)
                for _ in range(8):
                    b[min(len(b) - 1, at + r.randrange(4, 40))] = r.randrange(256)
            out = bytes(b)
        q = f'{folder}/rtmd{i:03d}.mp4'
        open(q, 'wb').write(out)
        listing.append(q)
    return listing


def check(listing, label, env, cache):
    paths = '\n'.join(listing) + '\n'
    run = subprocess.run([args.engine, 'scan', '--paths-file', '-', '--cache', cache], input=paths.encode(),
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=240)
    problems = []
    if run.returncode != 0:
        problems.append(f'exit {run.returncode}: ' + run.stderr.decode('utf8', 'replace')[-400:])
    seen, tier1, errors, done = set(), 0, 0, None
    for line in run.stdout.decode('utf8', 'replace').splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            problems.append('a line that is not JSON: ' + line[:120])
            continue
        if m['type'] == 'clip' or m['type'] == 'error':
            seen.add(m['path'])
            if m.get('tier') == 2 and m.get('iso') not in (None, 1600) and m['iso'] < 0:
                problems.append('a negative ISO')
            tier1 += m['type'] == 'clip' and m.get('tier') == 1
            errors += m['type'] == 'error'
        elif m['type'] == 'done':
            done = m
    if done is None:
        problems.append('no done line')
    missing = set(listing) - seen
    if missing:
        problems.append(f'{len(missing)} clips never reported')
    print(f'{label}: {len(listing)} clips, {tier1} with Tier 1 lines, {errors} errors, ' +
          (f'{done["wallMs"]} ms, {done.get("degraded", 0)} degraded' if done else 'no summary'))
    for p in problems:
        print('FAIL', p)
    return not problems

tmp = args.keep or tempfile.mkdtemp(prefix='engine-fuzz.')
try:
    sources_dir = os.path.join(tmp, 'src')
    out = os.path.join(tmp, 'out')
    os.makedirs(sources_dir)
    os.makedirs(out)
    sources = make_sources(sources_dir)
    listing = damage(sources, out, args.count) + hostile_rtmd(sources, out, 90)
    good = check(listing, 'with ffmpeg', dict(os.environ), os.path.join(tmp, 'c1'))
    good = check(listing, 'without ffmpeg', dict(os.environ, ENGINE_TEST_NO_FFMPEG='1'), os.path.join(tmp, 'c2')) and good
finally:
    if not args.keep:
        shutil.rmtree(tmp, ignore_errors=True)
sys.exit(0 if good else 1)
