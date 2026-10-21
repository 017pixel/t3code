"""Compare synthetic proof PNG pairs without alignment, resampling or masking.

Usage: python3 compare.py /absolute/evidence/directory
Requires Pillow and numpy. Screenshots themselves must stay outside git.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

root = Path(sys.argv[1]).resolve()
manifest = json.loads((root / 'manifest-final.json').read_text())
entries = {x['name']: x for x in manifest['captures']}
rows = []
for name, entry in sorted(entries.items()):
    if not name.startswith('after-'):
        continue
    before = 'before-' + name[len('after-'):]
    if before not in entries:
        continue
    a = np.array(Image.open(root / before).convert('RGB')).astype(np.int16)
    b = np.array(Image.open(root / name).convert('RGB')).astype(np.int16)
    if a.shape != b.shape:
        raise ValueError(f'Size mismatch: {before}, {name}')
    delta = np.abs(a - b).max(axis=2)
    item = {'before': before, 'after': name, 'key': entry['key'],
            'width': entry['width'], 'theme': entry['theme'],
            'frame': entry['frame'], 'raster': [a.shape[1], a.shape[0]],
            'beforeScroll': entries[before]['geometry'].get('scrollTop'),
            'afterScroll': entry['geometry'].get('scrollTop'), 'thresholds': {}}
    for threshold in [0, 16]:
        mask = delta > threshold
        y, x = np.where(mask)
        intensity = np.where(mask, np.maximum(64, np.minimum(255, delta * 32)), 0).astype(np.uint8)
        diff = np.zeros_like(a, dtype=np.uint8)
        diff[:, :, 0] = intensity
        diff[:, :, 2] = intensity
        target = f'diff-{threshold}-' + name[len('after-'):]
        Image.fromarray(diff).save(root / target)
        item['thresholds'][str(threshold)] = {
            'pixels': int(mask.sum()), 'percent': float(mask.mean() * 100),
            'bbox': [int(x.min()), int(y.min()), int(x.max()+1), int(y.max()+1)] if len(x) else None,
            'file': target}
    rows.append(item)
(root / 'pixel-diffs.json').write_text(json.dumps(rows, indent=2) + '\n')
for key in sorted(set(x['key'] for x in rows)):
    subset = [x for x in rows if x['key'] == key]
    for offset in range(0, len(subset), 6):
        batch = subset[offset:offset+6]
        canvas = Image.new('RGB', (1200, len(batch)*470), '#e5e7eb')
        draw = ImageDraw.Draw(canvas)
        for i, row in enumerate(batch):
            for j, (label, path) in enumerate([('BEFORE', row['before']), ('AFTER', row['after']), ('ZERO THRESHOLD x32', row['thresholds']['0']['file'])]):
                im = Image.open(root / path).convert('RGB')
                im.thumbnail((396, 420))
                draw.text((j*400+4, i*470+4), f"{label}: {row['width']} {row['theme']} {row['frame']}", fill='black')
                canvas.paste(im, (j*400+(400-im.width)//2, i*470+25))
            draw.text((4, i*470+450), f"Changed pixels: >0={row['thresholds']['0']['pixels']}; >16={row['thresholds']['16']['pixels']}", fill='black')
        canvas.save(root / f"sheet-{key}-{offset//6+1}.jpg", quality=92)
print(json.dumps({'pairs': len(rows), 'identical': sum(x['thresholds']['0']['pixels']==0 for x in rows), 'changed': sum(x['thresholds']['0']['pixels']>0 for x in rows)}))
