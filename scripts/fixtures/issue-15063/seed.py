"""Seed an initialized, stopped, disposable .t3 home for static visual replay.

Usage: python3 scripts/fixtures/issue-15063/seed.py .t3/evidence-replay single
Variants: single, duplicates, fallback. Start the server once to migrate this new
home, stop it, then seed. Never use a home containing work you want to retain.
This does not reproduce provider delivery: it contains projections only. The
captured lifecycle recordings used real fork/merge/send commands instead.
"""
import argparse
import json
import pathlib
import sqlite3

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('home', type=pathlib.Path)
parser.add_argument('variant', choices=['single', 'duplicates', 'fallback'])
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[3]
home = args.home.resolve()
if not home.is_relative_to(root / '.t3') or home == root / '.t3':
    parser.error('Use a dedicated child of this checkout’s .t3 directory.')
if (home / 'userdata' / 'statev2.sqlite-wal').exists():
    parser.error('Stop the evidence server and checkpoint its database first.')
path = home / 'userdata' / 'statev2.sqlite'
if not path.is_file():
    parser.error('Initialize this disposable home with the server first.')
data = json.loads(pathlib.Path(__file__).with_name('synthetic.json').read_text())['fixtures'][args.variant]
with sqlite3.connect(path) as db:
    # Refuse any populated home, including live state copied into a worktree.
    count = db.execute('select count(*) from orchestration_v2_projection_runs').fetchone()[0]
    if count:
        parser.error('Refusing to replace populated state. Use a fresh evidence home.')
    db.execute('PRAGMA foreign_keys=OFF')
    for table, rows in data.items():
        db.execute(f'DELETE FROM "{table}"')
        for original in rows:
            row = dict(original)
            if table == 'projection_projects':
                row['workspace_root'] = str(root)
                row['title'] = 'issue-15063'
            columns = ','.join('"' + key + '"' for key in row)
            values = ','.join('?' for _ in row)
            db.execute(f'INSERT INTO "{table}" ({columns}) VALUES ({values})', list(row.values()))
print(f'Seeded {args.variant} into {home}. Clear this evidence origin’s thread cache before opening it.')
print('Parent thread: mcp:62560f84-a9c3-410b-9654-2c196ab6f6e9')
if args.variant == 'duplicates':
    print('For badge/width replay configure Codex displayName to:')
    print('Codex research account with a deliberately long display name')
    print('Add enabled codexEvidence (driver codex, displayName Codex secondary).')
if args.variant == 'fallback':
    print('Set composer draft via useComposerDraftStore.setModelSelection to:')
    print('{instanceId: "codex", model: "custom-evidence-model"}, explicit=true, replaceOptions=true.')
    print('This is a static missing-source/custom-slug harness; the picker may show a catalog fallback.')
