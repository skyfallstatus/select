#!/bin/zsh
# Looks for private words in everything git tracks or would track, in the full history, and in image metadata.
# The words live in .local/private-patterns.txt, which is git-ignored, so the list itself never enters the repo.
# It fails loudly when that file is missing. A hit prints where it is, never the word.
#   scripts/privacy-scan.sh
cd "${0:A:h}/.."
exec /usr/bin/env python3 -I - <<'PY'
import os, re, struct, subprocess, sys, zlib

PATTERNS = '.local/private-patterns.txt'
IMAGES = 'docs/media'
problems = []

def die(message):
    print('privacy scan: ' + message, file=sys.stderr)
    sys.exit(1)

def git(*args):
    return subprocess.run(['git', *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout

if not os.path.exists(PATTERNS):
    die(f'{PATTERNS} is missing, so nothing was checked. Create it first: see docs/RELEASING.md.')
if subprocess.run(['git', 'check-ignore', '-q', PATTERNS]).returncode != 0:
    die(f'{PATTERNS} is not ignored by git. Fix .gitignore before anything else.')

patterns = []
for number, line in enumerate(open(PATTERNS, encoding='utf8'), 1):
    line = line.rstrip('\n')
    if not line.strip() or line.startswith('#'):
        continue
    try:
        patterns.append((number, re.compile(line)))
    except re.error as e:
        die(f'line {number} of {PATTERNS} is not a valid pattern: {e}')
if not patterns:
    die(f'{PATTERNS} has no patterns in it, so nothing was checked.')

def scan_text(where, data):
    text = data.decode('utf8', 'replace') if isinstance(data, bytes) else data
    for number, regex in patterns:
        for m in regex.finditer(text):
            line = text.count('\n', 0, m.start()) + 1
            problems.append(f'{where}:{line}  matches pattern on line {number}')
            break

tracked = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\0')
tracked = [p.decode('utf8', 'replace') for p in tracked if p]
if any(p.startswith('.local/') for p in tracked):
    problems.append('.local/ has files that git can see')
for path in tracked:
    scan_text('file name ' + path, path)
    # Compressed pixels match short patterns by chance. Images are checked by their metadata below.
    if os.path.isfile(path) and not path.lower().endswith(('.png', '.jpg', '.jpeg')):
        scan_text(path, open(path, 'rb').read())

# PNG chunks and JPEG segments that can carry words. The panel screenshots need none of them.
PNG_TEXT = {b'tEXt', b'zTXt', b'iTXt', b'eXIf', b'tIME'}

def png_metadata(data):
    found, pos = [], 8
    while pos + 8 <= len(data):
        size, kind = struct.unpack('>I4s', data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + size]
        if kind in PNG_TEXT:
            try:
                if kind == b'zTXt':
                    body = zlib.decompress(body[body.index(b'\0') + 2:])
                elif kind == b'iTXt' and body[body.index(b'\0') + 1] == 1:
                    body = zlib.decompress(body[body.rindex(b'\0') + 1:])
            except (ValueError, IndexError, zlib.error):
                pass
            found.append((kind.decode(), body))
        pos += 12 + size
    return found

def jpeg_metadata(data):
    found, pos = [], 2
    while pos + 4 <= len(data) and data[pos] == 0xFF:
        marker = data[pos + 1]
        if marker == 0xDA:
            break
        size = struct.unpack('>H', data[pos + 2:pos + 4])[0]
        if marker in (0xE1, 0xE2, 0xED, 0xFE):
            found.append((f'FF{marker:02X}', data[pos + 4:pos + 2 + size]))
        pos += 2 + size
    return found

for path in tracked:
    lower = path.lower()
    if not path.startswith(IMAGES + '/') or not os.path.isfile(path):
        continue
    data = open(path, 'rb').read()
    if lower.endswith('.png') and data[:8] == b'\x89PNG\r\n\x1a\n':
        found = png_metadata(data)
    elif lower.endswith(('.jpg', '.jpeg')) and data[:2] == b'\xff\xd8':
        found = [f for f in jpeg_metadata(data) if not f[1].startswith(b'ICC_PROFILE')]
    else:
        problems.append(f'{path}: use PNG or JPEG here, this one can\'t be checked')
        continue
    for kind, body in found:
        problems.append(f'{path}: has {kind} metadata, strip it')
        scan_text(f'{path} {kind} metadata', body)

history = 0
if git('rev-parse', '--verify', '-q', 'HEAD').strip():
    commits = git('rev-list', '--all').split()
    history = len(commits)
    # Patches cover what every commit added or removed, and the format line covers who and why.
    log = git('log', '--all', '--full-history', '-p', '--binary', '--no-color',
              '--format=commit %H%nauthor %an <%ae>%ncommitter %cn <%ce>%n%B')
    current = '?'
    for chunk in re.split(rb'(?m)^(?=commit [0-9a-f]{40}$)', log):
        head = chunk[:48].decode('utf8', 'replace')
        current = head[7:19] if head.startswith('commit ') else current
        scan_text('history ' + current, chunk)
    scan_text('tag names', git('tag', '-l'))
    scan_text('branch names', git('branch', '-a'))
    names = git('rev-list', '--objects', '--all')
    scan_text('file names in history', names)

unique = sorted(set(problems))
for p in unique:
    print(p)
print(f'privacy scan: {len(tracked)} files, {history} commits, {len(patterns)} patterns, {len(unique)} problems')
sys.exit(1 if unique else 0)
PY
