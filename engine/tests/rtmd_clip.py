#!/usr/bin/env python3
"""Adds a Sony-style `rtmd` data track to a generated MP4, so the parser can be tested without a Sony file.

    rtmd_clip.py <in.mp4> <out.mp4> [--iso 1600] [--shutter-den 100] [--code 53343] [--gyro 40] [--no-log] [--gamut cine|other|none]

The layout follows what real files carry: a 0x1c-byte header, then tagged values, one sample per frame, with gyro
readings at 2 kHz. Everything is made up. fuzz.py imports this to build hostile tracks too.
"""
import argparse, math, random, struct


def box(kind, body):
    return struct.pack('>I4s', len(body) + 8, kind) + body


def tag(t, payload):
    return struct.pack('>HH', t, len(payload)) + payload


SLOG3 = bytes.fromhex('060e2b34040101060e06040101010605')
# The colour primaries label real S-Log3 clips carry beside it, which their sidecars call s-gamut3-cine. `other` is made up.
GAMUTS = {'cine': bytes.fromhex('060e2b34040101060e06040101030105'), 'other': bytes.fromhex('060e2b34040101060e06040101030199'), 'none': None}


def sample(iso=1600, shutter_den=100, code=53343, gyro=40.0, log=True, seed=0, readings=80, gamut='cine'):
    r = random.Random(seed)
    head = struct.pack('>H', 0x1c) + bytes(0x1c - 2)
    vals = [(int(r.gauss(0, gyro * 65.5)), int(r.gauss(0, gyro * 65.5)), int(r.gauss(0, gyro * 65.5))) for _ in range(readings)]
    motion = b''.join(struct.pack('>hhh', *[max(-32768, min(32767, v)) for v in t]) for t in vals)
    parts = [struct.pack('>HH', 0x060e, 0) + bytes(12),      # the 16-byte label, which has no real length field
             tag(0x8000, struct.pack('>H', code)),
             tag(0x8109, struct.pack('>II', 1, shutter_den)),
             tag(0x810b, struct.pack('>H', min(iso, 65535))),
             tag(0xe301, struct.pack('>I', iso)),
             tag(0xe303, b'\x06'),
             tag(0xe435, struct.pack('>I', 2000)),
             tag(0xe439, struct.pack('>f', 65.5)),
             tag(0xe43b, struct.pack('>II', readings, 6) + motion)]
    if log:
        parts.insert(1, tag(0x3210, SLOG3))
        if GAMUTS[gamut]:
            parts.insert(2, tag(0x3219, GAMUTS[gamut]))
    return head + b''.join(parts) + tag(0xffff, bytes(64))


def trak(sizes, offset, per_chunk, track_id=9):
    n = len(sizes)
    tkhd = box(b'tkhd', struct.pack('>I', 3) + bytes(8) + struct.pack('>I', track_id) + bytes(68))
    mdhd = box(b'mdhd', bytes(4) + bytes(8) + struct.pack('>II', 25, n) + bytes(4))
    hdlr = box(b'hdlr', bytes(8) + b'meta' + bytes(12) + b'Timed Metadata\0')
    entry = struct.pack('>I4s', 16, b'rtmd') + bytes(6) + struct.pack('>H', 1)
    stsd = box(b'stsd', bytes(4) + struct.pack('>I', 1) + entry)
    stts = box(b'stts', bytes(4) + struct.pack('>III', 1, n, 1))
    stsc = box(b'stsc', bytes(4) + struct.pack('>IIII', 1, 1, per_chunk, 1))
    stsz = box(b'stsz', bytes(4) + struct.pack('>II', 0, n) + b''.join(struct.pack('>I', s) for s in sizes))
    chunks = math.ceil(n / per_chunk)
    offsets, at = [], offset
    for c in range(chunks):
        offsets.append(at)
        at += sum(sizes[c * per_chunk:(c + 1) * per_chunk])
    stco = box(b'stco', bytes(4) + struct.pack('>I', chunks) + b''.join(struct.pack('>I', o) for o in offsets))
    stbl = box(b'stbl', stsd + stts + stsc + stsz + stco)
    return box(b'trak', tkhd + box(b'mdia', mdhd + hdlr + box(b'minf', stbl)))


def add_track(data, samples, per_chunk=12):
    """Returns the file with the samples in their own `mdat` before `moov` and a new track inside it."""
    pos = 0
    while pos + 8 <= len(data):
        size, kind = struct.unpack('>I4s', data[pos:pos + 8])
        if kind == b'moov':
            break
        pos += size
    else:
        raise SystemExit('no moov')
    moov_body = data[pos + 8:pos + size]
    payload = b''.join(samples)
    holder = box(b'mdat', payload)
    new = trak([len(s) for s in samples], pos + 8, per_chunk)
    return data[:pos] + holder + box(b'moov', moov_body + new) + data[pos + size:]


if __name__ == '__main__':
    a = argparse.ArgumentParser()
    a.add_argument('src')
    a.add_argument('dst')
    a.add_argument('--iso', type=int, default=1600)
    a.add_argument('--shutter-den', type=int, default=100)
    a.add_argument('--code', type=int, default=53343)
    a.add_argument('--gyro', type=float, default=40.0)
    a.add_argument('--frames', type=int, default=24)
    a.add_argument('--no-log', action='store_true')
    a.add_argument('--gamut', choices=sorted(GAMUTS), default='cine')
    o = a.parse_args()
    data = open(o.src, 'rb').read()
    samples = [sample(o.iso, o.shutter_den, o.code, o.gyro, not o.no_log, seed=i, gamut=o.gamut) for i in range(o.frames)]
    open(o.dst, 'wb').write(add_track(data, samples))
