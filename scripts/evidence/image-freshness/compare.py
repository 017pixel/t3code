#!/usr/bin/env python3
"""Compare unscaled full-frame RGBA captures. Requires Pillow 12.3.0.

Usage: compare.py BEFORE AFTER OUTPUT_PREFIX [--repeat FIXED_REPEAT]
Diff0 is always BEFORE versus AFTER with zero threshold; repeat noise is separate.
"""
import argparse
import json
from pathlib import Path
from PIL import Image, ImageChops, __version__


def compare(first, second, prefix):
    a, b = Image.open(first).convert('RGBA'), Image.open(second).convert('RGBA')
    assert a.size == b.size, 'No scaling permitted'
    delta = ImageChops.difference(a, b)
    values = [max(pixel) for pixel in delta.getdata()]
    mask0 = Image.new('L', a.size)
    mask0.putdata([255 if value else 0 for value in values])
    mask16 = Image.new('L', a.size)
    mask16.putdata([255 if value > 16 else 0 for value in values])
    amplified = delta.point(lambda value: min(255, value * 8)).convert('RGB')
    amplified.save(str(prefix) + '-diff0-amplified.png')
    overlay = b.convert('RGB')
    overlay.paste((255, 0, 255), mask=mask16)
    overlay.save(str(prefix) + '-diffT16-overlay.png')
    return {'size': a.size, 'totalPixels': len(values), 'maxChannelDelta': max(values), 'diff0': {'changedPixels': sum(value > 0 for value in values), 'bbox': mask0.getbbox()}, 'diffT16': {'changedPixels': sum(value > 16 for value in values), 'percentage': 100 * sum(value > 16 for value in values) / len(values), 'bbox': mask16.getbbox()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('before')
    parser.add_argument('after')
    parser.add_argument('prefix', type=Path)
    parser.add_argument('--repeat')
    args = parser.parse_args()
    args.prefix.parent.mkdir(parents=True, exist_ok=True)
    report = {'pillow': __version__, 'threshold': 16, 'amplification': 8, 'masks': [], 'transforms': [], 'comparison': compare(args.before, args.after, args.prefix)}
    if args.repeat:
        report['repeatNoise'] = compare(args.after, args.repeat, str(args.prefix) + '-repeat')
    Path(str(args.prefix) + '.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))

if __name__ == '__main__':
    main()
