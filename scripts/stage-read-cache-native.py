#!/usr/bin/env python3
"""Temporarily select the production-component static iOS evidence fixture.

Run --apply --backup-dir <outside-worktree-dir>, enqueue the simulator build
from apps/mobile with --profile read-cache-evidence, then --restore after its
archive is uploaded. The overlay never belongs in an implementation commit.
"""
import argparse
import json
from pathlib import Path
import shutil
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--backup-dir', required=True, type=Path)
p.add_argument('--apply', action='store_true')
p.add_argument('--restore', action='store_true')
p.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
a = p.parse_args()
assert a.apply != a.restore, 'Choose --apply or --restore'
mobile = a.root / 'apps/mobile'
backup = a.backup_dir.resolve()
assert not backup.is_relative_to(a.root.resolve()), 'Backup must be outside the checkout'
if a.apply:
    backup.mkdir(parents=True, exist_ok=True)
    assert not (backup / 'index.ts').exists(), 'Existing backup: restore it first'
    for name in ['index.ts', 'eas.json']:
        shutil.copy2(mobile / name, backup / name)
    shutil.copy2(a.root / 'scripts/fixtures/read-cache-native.tsx', mobile / 'src/read-cache.fixture.tsx')
    index = (mobile / 'index.ts').read_text()
    assert 'import App from "./src/App";' in index
    (mobile / 'index.ts').write_text(index.replace('import App from "./src/App";', 'import App from "./src/read-cache.fixture";'))
    config = json.loads((mobile / 'eas.json').read_text())
    config['build']['read-cache-evidence'] = {
        'corepack': True, 'distribution': 'internal',
        'env': {'APP_VARIANT': 'development', 'NODE_OPTIONS': '--max-old-space-size=4096'},
        'ios': {'simulator': True, 'image': 'macos-tahoe-26.6-xcode-27.1'},
    }
    (mobile / 'eas.json').write_text(json.dumps(config, indent=2) + '\n')
else:
    for name in ['index.ts', 'eas.json']:
        shutil.copy2(backup / name, mobile / name)
    (mobile / 'src/read-cache.fixture.tsx').unlink(missing_ok=True)
    for name in ['index.ts', 'eas.json']:
        (backup / name).unlink()
