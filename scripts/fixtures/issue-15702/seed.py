#!/usr/bin/env python3
"""Seed a stopped, isolated worktree T3 database; never use with the live T3 home."""
import argparse
import copy
import json
from pathlib import Path
import sqlite3
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('worktree', type=Path)
parser.add_argument('--servers-stopped', action='store_true', required=True)
args = parser.parse_args()
root = args.worktree.resolve()
db = root / '.t3/userdata/statev2.sqlite'
if not (root / '.git').exists() or not db.is_file():
    parser.error('Expected an existing isolated git worktree .t3 database')
if db.resolve().is_relative_to(Path.home() / '.t3'):
    parser.error('Refusing the live T3 home')
fixture = json.loads(Path(__file__).with_name('fixture.json').read_text())
settled = copy.deepcopy(fixture)
settled['id'] = fixture['id'] + ':settled-fixture'
settled['title'] = 'Mixed PR badge settled — 3 open, 3 closed'
settled['lineage']['rootThreadId'] = settled['id']
settled['settledOverride'] = 'settled'
settled['settledAt'] = fixture['updatedAt']
con = sqlite3.connect(db)
con.row_factory = sqlite3.Row
with con:
    template = con.execute('SELECT * FROM orchestration_events WHERE event_type=? AND stream_id=? LIMIT 1', ('thread.created', fixture['id'])).fetchone()
    if template is None:
        raise SystemExit('Fixture source thread.created event missing')
    projection = con.execute('SELECT * FROM orchestration_v2_projection_threads WHERE thread_id=?', (fixture['id'],)).fetchone()
    if projection is None:
        raise SystemExit('Fixture source projection missing')
    for thread in (fixture, settled):
        encoded = json.dumps(thread, separators=(',', ':'))
        rows = con.execute('SELECT sequence FROM orchestration_events WHERE stream_id=?', (thread['id'],)).fetchall()
        if rows:
            # These fixture-only events carry complete thread snapshots, so replay and reads agree.
            con.execute('UPDATE orchestration_events SET payload_json=?,occurred_at=? WHERE stream_id=?', (encoded, thread['updatedAt'], thread['id']))
        else:
            event = dict(template)
            event.pop('sequence')
            event.update(event_id=str(uuid.uuid4()), stream_id=thread['id'], stream_version=1, payload_json=encoded, occurred_at=thread['updatedAt'], command_id=None)
            columns = ','.join(event)
            con.execute(f'INSERT INTO orchestration_events ({columns}) VALUES ({",".join("?" for _ in event)})', tuple(event.values()))
        row = dict(projection)
        row.update(thread_id=thread['id'],title=thread['title'],created_at=thread['createdAt'],updated_at=thread['updatedAt'],archived_at=None,deleted_at=None,payload_json=encoded)
        columns = ','.join(row)
        con.execute(f'INSERT OR REPLACE INTO orchestration_v2_projection_threads ({columns}) VALUES ({",".join("?" for _ in row)})', tuple(row.values()))
    # Keep the shared event log and its V2 read cursor in agreement after inserting F-settled.
    seq = con.execute('SELECT MAX(sequence) FROM orchestration_events').fetchone()[0]
    con.execute('UPDATE orchestration_v2_projection_metadata SET last_sequence=?,updated_at=? WHERE projection_name=?', (seq,fixture['updatedAt'],'thread-projections'))
print(f'Seeded F and F-settled in {db}')
