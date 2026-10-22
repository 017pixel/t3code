#!/usr/bin/env python3
"""Reset an OFFLINE, isolated dev database to public issue-23378 proof data.

Run dev:desktop --no-seed once to initialize migrations, stop it, then run:
  python3 scripts/issue-23378/seed-evidence.py /absolute/evidence-home
Never pass the live T3 home. This fixture uses real local authentication.
"""
import json
import pathlib
import sqlite3
import sys

home = pathlib.Path(sys.argv[1]).resolve()
if home == pathlib.Path.home() / '.t3' or 'evidence' not in str(home):
    raise SystemExit('Expected an isolated evidence home, never the live install')
db = home / 'userdata/statev2.sqlite'
if not db.is_file():
    raise SystemExit('Initialize the isolated dev database first')
connection = sqlite3.connect(db)
connection.execute('PRAGMA foreign_keys=OFF')
for (table,) in connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
    if table not in ('effect_sql_migrations', 'sqlite_sequence'):
        connection.execute('DELETE FROM "' + table.replace('"', '""') + '"')
now = '2026-10-22T12:00:00.000Z'
workspace = pathlib.Path('/tmp/issue-23378-evidence/demo-project')
workspace.mkdir(parents=True, exist_ok=True)
(workspace / 'README.md').write_text('# Launch recovery demo\n\nSynthetic public fixture. No provider is started.\n')
connection.execute('INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (?,?,?,?,?,?)', ('proof-project', 'Launch recovery demo', str(workspace), '[]', now, now))
thread = dict(createdBy='user', creationSource='web', id='proof-thread', projectId='proof-project', title='Verify desktop startup recovery', providerInstanceId='codex', modelSelection=dict(instanceId='codex', model='gpt-5.4'), runtimeMode='full-access', interactionMode='default', branch=None, worktreePath=None, pullRequests=[], activeProviderThreadId=None, lineage=dict(parentThreadId=None, relationshipToParent=None, rootThreadId='proof-thread'), forkedFrom=None, createdAt=now, updatedAt=now, archivedAt=None, settledOverride=None, settledAt=None, snoozedUntil=None, snoozedAt=None, lastVisitedAt=now, deletedAt=None)
connection.execute('INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json,provider_instance_id) VALUES (?,?,?,?,?,?,?,?,?,?)', ('proof-thread','proof-project',thread['title'],'codex','full-access','default',now,now,json.dumps(thread),'codex'))
connection.commit()
connection.execute('VACUUM')
connection.close()
(home / 'userdata/client-settings.json').write_text(json.dumps({'onboardingCompletedAt': now, 'notificationMode': 'off', 'inAppNotificationsEnabled': False, 'panelAnimationDurationMs': 0}))
(home / 'userdata/desktop-settings.json').write_text(json.dumps({'mainWindowBounds': {'x': 0, 'y': 0, 'width': 1920, 'height': 1080}}))
(home / 'userdata/environment-id').write_text('23378000-0000-4000-8000-000000000001')
(home / 'userdata/anonymous-id').write_text('23378000-0000-4000-8000-000000000002')
print('Seeded one synthetic project and one stopped thread:', db)
