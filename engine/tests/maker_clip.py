#!/usr/bin/env python3
"""Puts a camera maker's own record into a clip made by ffmpeg, the way real cameras store it, for engine/tests/contract.sh.

    maker_clip.py canon <src.mp4> <dst.mp4>   Canon's uuid box in moov, with TIFF blocks naming camera, lens and time
    maker_clip.py sony-mp4 <src.mp4> <dst.mp4> Sony's XML in a top-level meta box after moov, as Sony writes it
    maker_clip.py sony-mxf <src.mxf> <dst.mxf> Sony's XML in a fill item of the MXF header, which readers skip

Only for clips whose moov is last in the file, as ffmpeg writes them without faststart, so no sample offset moves.
"""
import struct, sys

CANON_UUID = bytes.fromhex('85c0b687820f11e08111f4ce462b6a48')
SONY_XML = (b'<?xml version="1.0" encoding="UTF-8"?><NonRealTimeMeta><CreationDate value="2025-12-12T19:03:06+01:00"/>'
            b'<Device manufacturer="Sony" modelName="ILME-FX6V"/><Lens modelName="FE 24-70mm F2.8 GM II"/>'
            b'<Item name="CaptureGammaEquation" value="s-log3-cine"/></NonRealTimeMeta>')


def box(kind, body):
    return struct.pack('>I4s', 8 + len(body), kind) + body


def tiff(entries):
    """A little-endian TIFF block with one directory of ASCII tags."""
    head = b'II*\x00' + struct.pack('<I', 8)
    n = len(entries)
    data_at = 8 + 2 + n * 12 + 4
    table, data = b'', b''
    for tag, text in sorted(entries.items()):
        raw = text.encode() + b'\x00'
        if len(raw) <= 4:
            value = raw.ljust(4, b'\x00')
        else:
            value = struct.pack('<I', data_at + len(data))
            data += raw
        table += struct.pack('<HHI', tag, 2, len(raw)) + value
    return head + struct.pack('<H', n) + table + struct.pack('<I', 0) + data


def top_boxes(b):
    pos, out = 0, []
    while pos + 8 <= len(b):
        size, kind = struct.unpack('>I4s', b[pos:pos + 8])
        if size == 1:
            size = struct.unpack('>Q', b[pos + 8:pos + 16])[0]
        if size == 0:
            size = len(b) - pos
        out.append((pos, size, kind))
        pos += size
    return out


def with_moov_child(b, child):
    boxes = top_boxes(b)
    pos, size, kind = boxes[-1]
    assert kind == b'moov', 'moov must be the last box'
    return b[:pos] + struct.pack('>I', size + len(child)) + b[pos + 4:pos + size] + child


def canon(src, dst):
    b = open(src, 'rb').read()
    cmt1 = tiff({0x010F: 'Canon', 0x0110: 'Canon EOS R6'})
    cmt2 = tiff({0xA434: 'RF24-70mm F2.8 L IS USM', 0x9003: '2025:09:01 15:45:33', 0x9011: '+01:00'})
    child = box(b'uuid', CANON_UUID + box(b'CNCV', b'CanonCR3_001/00.09.00/00.00.00') + box(b'CMT1', cmt1) + box(b'CMT2', cmt2))
    open(dst, 'wb').write(with_moov_child(b, child))


def sony_mp4(src, dst):
    b = open(src, 'rb').read()
    assert top_boxes(b)[-1][2] == b'moov', 'moov must be the last box'
    # Sony's own layout: version and flags, a handler, then an xml box holding the clip's XML.
    meta = box(b'meta', b'\x00\x00\x00\x00' + box(b'hdlr', b'\x00' * 8 + b'meta' + b'\x00' * 13) + box(b'xml ', b'\x00\x00\x00\x00' + SONY_XML))
    open(dst, 'wb').write(b + meta)


def sony_mxf(src, dst):
    b = bytearray(open(src, 'rb').read())
    key = bytes.fromhex('060e2b34010101')
    i = 0
    while True:
        i = b.find(key, i)
        assert 0 <= i < 1 << 20, 'no fill item big enough in the header'
        if b[i + 8:i + 12] == bytes.fromhex('03010210'):
            first = b[i + 16]
            n = first & 0x7F if first & 0x80 else 0
            length = int.from_bytes(b[i + 17:i + 17 + n], 'big') if n else first
            start = i + 17 + n
            if length >= len(SONY_XML):
                b[start:start + length] = SONY_XML.ljust(length, b' ')
                break
        i += 1
    open(dst, 'wb').write(bytes(b))


if __name__ == '__main__':
    {'canon': canon, 'sony-mp4': sony_mp4, 'sony-mxf': sony_mxf}[sys.argv[1]](sys.argv[2], sys.argv[3])
