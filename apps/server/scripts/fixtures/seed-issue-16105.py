#!/usr/bin/env python3
"""Seed stopped, isolated proof databases from a UI-created thread skeleton.

Usage: python3 seed-issue-16105.py /absolute/worktree/.t3 [...]
Projection-only visual/search fixtures; not coherent orchestration event history.
"""
import json
import pathlib
import socket
import sqlite3
import sys

fixture = json.loads(pathlib.Path(__file__).with_name('issue-16105.json').read_text())
for port in (14829, 15209):
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1', port)) == 0:
            raise SystemExit(f'Stop proof server on {port} before seeding')
for argument in sys.argv[1:]:
    home = pathlib.Path(argument).resolve()
    if home.name != '.t3' or home.parent.parent != pathlib.Path('/home/ubuntu/wt'):
        raise SystemExit('Only isolated /home/ubuntu/wt/<worktree>/.t3 homes are allowed')
    database = home / 'userdata/statev2.sqlite'
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    thread = fixture['threadId']
    messages = list(connection.execute('SELECT * FROM orchestration_v2_projection_messages WHERE thread_id=? ORDER BY created_at,message_id', (thread,)))
    items = list(connection.execute('SELECT * FROM orchestration_v2_projection_turn_items WHERE thread_id=? ORDER BY ordinal', (thread,)))
    positions = {json.loads(row['payload_json']).get('messageId'): row['ordinal'] for row in items}
    messages.sort(key=lambda row: positions[row['message_id']])
    templates = {role: json.loads(next(row['payload_json'] for row in messages if row['role'] == role)) for role in ('user', 'assistant')}
    item_templates = {role: json.loads(next(row['payload_json'] for row in items if row['type'] == role + '_message')) for role in ('user', 'assistant')}
    assert len(messages) >= len(fixture['messages']), 'Need five real message skeletons'
    backup = database.with_suffix('.before-16105-seed.sqlite')
    if not backup.exists():
        with sqlite3.connect(backup) as target:
            connection.backup(target)
    seeded = []
    with connection:
        keep_items = []
        keep_messages = []
        for source, case in zip(messages, fixture['messages']):
            source_payload = json.loads(source['payload_json'])
            old_item = next(row for row in items if json.loads(row['payload_json']).get('messageId') == source['message_id'])
            old_payload = json.loads(old_item['payload_json'])
            role = case['role']
            message = dict(templates[role])
            item = dict(item_templates[role])
            for key in ('id', 'threadId', 'runId', 'nodeId'):
                message[key] = source_payload[key]
            for key in ('id', 'threadId', 'runId', 'nodeId', 'providerThreadId', 'providerTurnId', 'nativeItemRef', 'parentItemId', 'ordinal'):
                item[key] = old_payload[key]
            item['messageId'] = message['id']
            for payload in (message, item):
                for key in ('context', 'scheduledTaskId'):
                    payload.pop(key, None)
                    if key in case:
                        payload[key] = case[key]
                payload['text'] = case['text']
                for key in ('createdAt', 'updatedAt', 'startedAt', 'completedAt'):
                    if key in payload:
                        payload[key] = fixture['timestamp']
            message['streaming'] = False
            if role == 'assistant':
                item['streaming'] = False
            connection.execute('UPDATE orchestration_v2_projection_messages SET role=?,streaming=0,created_at=?,updated_at=?,payload_json=? WHERE message_id=?', (role, fixture['timestamp'], fixture['timestamp'], json.dumps(message), message['id']))
            connection.execute('UPDATE orchestration_v2_projection_turn_items SET type=?,updated_at=?,payload_json=? WHERE turn_item_id=?', (role+'_message', fixture['timestamp'], json.dumps(item), item['id']))
            keep_items.append(item['id'])
            keep_messages.append(message['id'])
            seeded.append({'fixture':case['fixture'], 'message':message, 'turnItem':item})
        for table, column, retained in [('orchestration_v2_projection_messages','message_id',keep_messages), ('orchestration_v2_projection_turn_items','turn_item_id',keep_items), ('orchestration_v2_turn_item_positions','turn_item_id',keep_items)]:
            placeholders = ','.join('?' for _ in retained)
            connection.execute(f'DELETE FROM {table} WHERE thread_id=? AND {column} NOT IN ({placeholders})', [thread, *retained])
        row = connection.execute('SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?', (thread,)).fetchone()
        payload = json.loads(row[0])
        payload['title'] = fixture['title']
        connection.execute('UPDATE orchestration_v2_projection_threads SET title=?,payload_json=? WHERE thread_id=?', (fixture['title'],json.dumps(payload),thread))
    manifest = database.with_name('issue-16105-seeded.json')
    manifest.write_text(json.dumps({'fixture':fixture,'seeded':seeded},indent=2)+'\n')
    connection.close()
    print(json.dumps({'database':str(database),'manifest':str(manifest),'messages':len(seeded)}))
