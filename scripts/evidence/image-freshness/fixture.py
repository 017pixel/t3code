#!/usr/bin/env python3
"""Public image freshness fixture. Run COMMAND ROOT; ROOT is a disposable project."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import zlib


def png(rgba):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 100, 100, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\0' + bytes(rgba) * 100) * 100, 9)) + chunk(b'IEND', b'')

COLORS = {'red': (255, 0, 0, 255), 'blue': (0, 0, 255, 255)}
CANONICAL = {name: png(rgba) for name, rgba in COLORS.items()}


def validate(data):
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    offset, raw = 8, b''
    while offset < len(data):
        length = struct.unpack('>I', data[offset:offset + 4])[0]
        kind, payload = data[offset + 4:offset + 8], data[offset + 8:offset + 8 + length]
        assert zlib.crc32(kind + payload) == struct.unpack('>I', data[offset + 8 + length:offset + 12 + length])[0]
        if kind == b'IHDR':
            assert struct.unpack('>IIBBBBB', payload) == (100, 100, 8, 6, 0, 0, 0)
        if kind == b'IDAT':
            raw += payload
        offset += 12 + length
    decoded = zlib.decompress(raw)
    color = next(name for name, rgba in COLORS.items() if decoded == (b'\0' + bytes(rgba) * 100) * 100)
    assert data == CANONICAL[color]
    return {'dimensions': [100, 100], 'rgba': COLORS[color], 'color': color}


def replace(path, data, atomic):
    before = path.stat() if path.exists() else None
    if atomic:
        fd, temporary = tempfile.mkstemp(dir=path.parent)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    else:
        with path.open('r+b' if before else 'wb') as stream:
            stream.seek(0)
            stream.write(data)
            stream.truncate()
            stream.flush()
            os.fsync(stream.fileno())
    after = path.stat()
    if before:
        assert ((before.st_dev, before.st_ino) != (after.st_dev, after.st_ino)) == atomic
    return {'before': [before.st_dev, before.st_ino] if before else None, 'after': [after.st_dev, after.st_ino]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['init', 'red-inplace', 'blue-inplace', 'red-atomic', 'blue-atomic', 'manifest'])
    parser.add_argument('root', type=Path)
    args = parser.parse_args()
    directory = args.root / 'evidence-public'
    directory.mkdir(parents=True, exist_ok=True)
    state_path = directory / '.fixture-state.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else {'sequence': 0, 'phase': 'uninitialized'}
    changes = {}
    if args.command != 'manifest':
        color = 'red' if args.command == 'init' else args.command.split('-')[0]
        atomic = args.command.endswith('-atomic')
        changes['repro.png'] = replace(directory / 'repro.png', CANONICAL[color], atomic)
        svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="{color}"/></svg>\n'.encode()
        changes['swatch.svg'] = replace(directory / 'swatch.svg', svg, atomic)
        if args.command == 'init':
            (directory / 'immutable-upload.png').write_bytes(CANONICAL['red'])
            (directory / 'style.css').write_text('body { font: 16px sans-serif; margin: 24px; } img { width: 100px; height: 100px; margin-right: 24px; }\n')
            (directory / 'index.html').write_text('<!doctype html><html><head><meta charset="utf-8"><title>Public image freshness fixture</title><link rel="stylesheet" href="style.css"></head><body><h1>Public image freshness fixture</h1><p>PNG and SVG live siblings</p><img src="repro.png" alt="Live PNG"><img src="swatch.svg" alt="Live SVG"></body></html>\n')
        state = {'sequence': state['sequence'] + 1, 'phase': args.command}
        state_path.write_text(json.dumps(state))
    files = []
    for path in sorted(directory.iterdir()):
        if path.name.startswith('.'):
            continue
        data, info = path.read_bytes(), path.stat()
        record = {'path': str(path.relative_to(args.root)), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'device': info.st_dev, 'inode': info.st_ino}
        if path.suffix == '.png':
            record.update(validate(data))
        files.append(record)
    print(json.dumps({**state, 'changes': changes, 'files': files, 'canonical': {name: {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)} for name, data in CANONICAL.items()}}, indent=2))

if __name__ == '__main__':
    main()
