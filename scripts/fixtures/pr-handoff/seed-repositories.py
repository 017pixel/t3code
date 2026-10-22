#!/usr/bin/env python3
"""Create isolated repositories; refuse to overwrite an existing fixture."""
import json, os, pathlib, subprocess
fixture = json.loads(pathlib.Path(__file__).with_name('fixture.json').read_text())
root = pathlib.Path(fixture['root']).resolve()
if not str(root).startswith('/tmp/'):
    raise SystemExit('Set fixture.json root to an isolated directory below /tmp.')
paths = [root / project['directory'] for project in fixture['projects']]
if any(path.exists() for path in paths):
    raise SystemExit('Fixture exists; refusing to overwrite it. Remove it or restore a stopped snapshot.')
for project, path in zip(fixture['projects'], paths):
    path.mkdir(parents=True)
    def git(*args):
        subprocess.run(['git', '-C', str(path), *args], check=True, stdout=subprocess.DEVNULL)
    git('init', '-b', 'master')
    git('config', 'user.name', 'T3 fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    (path / 'README.md').write_text('Isolated pull request checkout fixture.\n')
    git('add', 'README.md')
    subprocess.run(['git', '-C', str(path), 'commit', '-m', 'fixture'], check=True,
        stdout=subprocess.DEVNULL, env={**os.environ, 'GIT_AUTHOR_DATE':'2026-10-22T00:00:00Z', 'GIT_COMMITTER_DATE':'2026-10-22T00:00:00Z'})
    git('remote', 'add', 'origin', project['origin'])
print(root)
