#!/usr/bin/env python3
"""Seed stopped, isolated V2 visual state; or write a sequence image.

Seed: --template <migrated isolated sqlite> --home <empty isolated home>.
Write: --color red|green|blue [--atomic] [--path <sandbox PNG>].
The three completed Read rows are preseeded. Expand them in order after each
write; this exercises production signing/cache/rendering, not event ingestion.
Never use this script with a running target server or the live T3 home.
"""
import argparse
import json
from pathlib import Path
import sqlite3
import struct
import zlib

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--template', type=Path)
p.add_argument('--home', type=Path)
p.add_argument('--color', choices=['red', 'green', 'blue'])
p.add_argument('--atomic', action='store_true')
p.add_argument('--path', type=Path, default=Path('/tmp/issue-13138-fixture/outside/square.png'))
a = p.parse_args()
if a.color:
    rgb = {'red': (255, 0, 0), 'green': (0, 255, 0), 'blue': (0, 0, 255)}[a.color]
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 100, 100, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress((b'\0' + bytes(rgb) * 100) * 100)) + chunk(b'IEND', b'')
    a.path.parent.mkdir(parents=True, exist_ok=True)
    target = a.path.with_suffix('.replacement.png') if a.atomic else a.path
    target.write_bytes(png)
    if a.atomic:
        target.replace(a.path)
    print(json.dumps({'color': a.color, 'atomic': a.atomic, 'inode': a.path.stat().st_ino, 'bytes': len(png)}))
else:
    assert a.home and a.template, '--home and --template required'
    assert '.t3/userdata' not in str(a.home.resolve()), 'Use a disposable evidence home'
    dest = a.home / 'userdata/statev2.sqlite'
    assert not dest.exists(), 'Refusing to replace an existing database'
    dest.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(f'file:{a.template.resolve()}?mode=ro', uri=True)
    db = sqlite3.connect(dest)
    for (sql,) in src.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type='table' AND name NOT LIKE 'sqlite_%'"):
        db.execute(sql)
    for row in src.execute('SELECT * FROM effect_sql_migrations'):
        db.execute('INSERT INTO effect_sql_migrations VALUES (' + ','.join('?' for _ in row) + ')', row)
    f = json.loads((Path(__file__).parent / 'fixtures/read-image-cache.json').read_text())
    def put(table, values):
        db.execute(f'INSERT INTO {table} (' + ','.join(values) + ') VALUES (' + ','.join('?' for _ in values) + ')', list(values.values()))
    put('projection_projects', f['project'])
    for name, key, ident, extra in [
        ('threads', 'thread', 'thread_id', {'project_id': f['project']['project_id'], 'title': f['thread']['title'], 'default_provider': 'claudeAgent', 'runtime_mode': 'full-access', 'interaction_mode': 'default', 'created_at': f['clock'], 'updated_at': f['clock'], 'provider_instance_id': 'claudeAgent'}),
        ('runs', 'run', 'run_id', {'thread_id': f['thread']['id'], 'ordinal': 1, 'provider': 'claudeAgent', 'status': 'completed', 'requested_at': f['clock'], 'completed_at': f['clock'], 'provider_instance_id': 'claudeAgent'}),
        ('nodes', 'node', 'node_id', {'thread_id': f['thread']['id'], 'run_id': f['run']['id'], 'root_node_id': f['node']['id'], 'kind': 'root_turn', 'status': 'completed', 'started_at': f['clock'], 'completed_at': f['clock']}),
    ]:
        put('orchestration_v2_projection_' + name, {ident: f[key]['id'], **extra, 'payload_json': json.dumps(f[key])})
    for item in f['items']:
        put('orchestration_v2_projection_turn_items', {'turn_item_id': item['id'], 'thread_id': item['threadId'], 'run_id': item['runId'], 'node_id': item['nodeId'], 'ordinal': item['ordinal'], 'type': item['type'], 'status': item['status'], 'updated_at': item['updatedAt'], 'payload_json': json.dumps(item)})
        if item['type'] == 'assistant_message':
            put('orchestration_v2_projection_messages', {'message_id': item['messageId'], 'thread_id': item['threadId'], 'run_id': item['runId'], 'node_id': item['nodeId'], 'role': 'assistant', 'streaming': 0, 'created_at': item['startedAt'], 'updated_at': item['updatedAt'], 'payload_json': json.dumps({'id': item['messageId'], 'threadId': item['threadId'], 'runId': item['runId'], 'nodeId': item['nodeId'], 'role': 'assistant', 'text': item['text'], 'attachments': [], 'streaming': False, 'createdAt': item['startedAt'], 'updatedAt': item['updatedAt']})})
    for (sql,) in src.execute("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND type='index'"):
        db.execute(sql)
    db.commit()
    db.close()
    (dest.parent / 'environment-id').write_text(f['environmentId'])
    Path(f['project']['workspace_root']).mkdir(parents=True, exist_ok=True)
    print('Seeded isolated V2 rendering fixture:', dest)
