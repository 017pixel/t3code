#!/usr/bin/env python3
"""Generate an isolated Git repository: python3 diff-identity.py DIR VARIANT.

DIR must be empty on first use. Later calls preserve the baseline and replace
only this generator's files. No application database is opened.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

seed_path = Path(__file__).with_name('diff-identity.seed.json')
seed = json.loads(seed_path.read_text())
root = Path(sys.argv[1]).resolve()
variant = sys.argv[2]
assert variant in seed['variants']
root.mkdir(parents=True, exist_ok=True)
env = {**os.environ, 'GIT_AUTHOR_DATE': seed['date'], 'GIT_COMMITTER_DATE': seed['date']}
def git(*args):
    return subprocess.check_output(['git', '-C', str(root), *args], env=env)
def write(name, value):
    (root / name).write_text(value)
def lines(kind, i, count):
    return ''.join(f'{n:05d} {kind} {i} ' + 'x' * seed['lineWidth'] + '\n' for n in range(count))
if not (root / '.git').exists():
    assert not list(root.iterdir()), 'Refusing to initialize a nonempty directory'
    git('init', '-b', 'master')
    git('config', 'user.name', 'Diff identity fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'diff.renames', 'true')
    git('config', 'diff.renameLimit', '1000')
    git('config', 'core.autocrlf', 'false')
    git('config', 'fixture.diffIdentity', '1')
    for i in range(seed['copies']):
        for prefix, kind in [('a-modified', 'old-modified'), ('c-deleted', 'deleted'), ('d-rename', 'rename')]:
            write(f'{prefix}-{i}.txt', lines(kind, i, seed['smallLines']))
    write('f-old-changed-rename.txt', lines('changed-rename', 0, 40))
    write('g-type-replacement.txt', 'regular file replaced with symlink\n')
    write('h-unique-neighbor.txt', 'neighbor before\n')
    git('add', '.')
    git('commit', '-m', 'Deterministic diff identity baseline')
    git('tag', 'fixture-base')
assert git('config', 'fixture.diffIdentity').strip() == b'1', 'Not a generated fixture repository'
# Restore only generator-owned paths so unrelated work in DIR survives reruns.
baseline = git('ls-tree', '-z', '--name-only', 'fixture-base').decode().split('\0')[:-1]
created = [f'{prefix}-{i}.txt' for i in range(seed['copies']) for prefix in ('b-added', 'e-renamed')] + [seed['longPath']]
git('rm', '-qf', '--cached', '--ignore-unmatch', '--', *created)
for name in created:
    if (root / name).is_symlink() or (root / name).exists():
        (root / name).unlink()
git('checkout', 'fixture-base', '--', *baseline)
owned = baseline + created
def stage():
    present = [name for name in owned if os.path.lexists(root / name)]
    git('rm', '-qf', '--cached', '--ignore-unmatch', '--', *[name for name in owned if name not in present])
    git('add', '-A', '--', *present)
if variant == 'duplicate':
    (root / 'g-type-replacement.txt').unlink()
    (root / 'g-type-replacement.txt').symlink_to('h-unique-neighbor.txt')
    write('h-unique-neighbor.txt', 'neighbor after\n')
elif variant != 'zero':
    count = seed['amplifiedLines'] if variant == 'amplified' else seed['smallLines']
    for i in range(seed['copies']):
        write(f'a-modified-{i}.txt', lines('new-modified', i, count))
        write(f'b-added-{i}.txt', lines('added', i, count))
        (root / f'c-deleted-{i}.txt').unlink()
        (root / f'd-rename-{i}.txt').rename(root / f'e-renamed-{i}.txt')
    (root / 'f-old-changed-rename.txt').rename(root / seed['longPath'])
    with (root / seed['longPath']).open('a') as stream:
        stream.write('changed rename sentinel\n')
stage()
args = ['diff', '--find-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--minimal', '--patch', 'HEAD', '--', *owned]
if variant.isdigit():
    target = int(variant)
    name = 'b-added-5.txt'
    current = git(*args)
    padding = target - len(current)
    assert padding > 0
    # Extending an existing line changes only its byte length, not hunk metadata.
    with (root / name).open('a') as stream:
        stream.write('p' * (padding - 1) + '\n')
    stage()
    delta = target - len(git(*args))
    data = (root / name).read_text()
    adjusted = data[:-1] + 'q' * delta + '\n' if delta >= 0 else data[:delta-1] + '\n'
    write(name, adjusted)
    stage()
    assert len(git(*args)) == target
patch = git(*args)
print(json.dumps({'schema': 1, 'variant': variant, 'baseline': git('rev-parse', 'HEAD').decode().strip(), 'seedSha256': hashlib.sha256(seed_path.read_bytes()).hexdigest(), 'patchBytes': len(patch), 'patchSha256': hashlib.sha256(patch).hexdigest(), 'stat': git('diff', '--find-renames', '--numstat', 'HEAD', '--', *owned).decode(), 'paths': owned, 'status': git('diff', '--find-renames', '--summary', 'HEAD', '--', *owned).decode()}, indent=2))
