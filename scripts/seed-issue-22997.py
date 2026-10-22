#!/usr/bin/env python3
"""Seed public composer proof into a stopped, migrated, isolated dev home.

From the pinned checkout, migrate a fresh isolated home (keep the terminal
session; wait for Listening, then stop this process with Ctrl+C):
  export PATH="$PWD/node_modules/.bin:$PATH"
  T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=0 node scripts/dev-runner.ts dev --home-dir /tmp/issue-22997/after-proof
With that server stopped:
  python3 scripts/seed-issue-22997.py /tmp/issue-22997/after-proof
For the separate C6 projection-only pending-answer control, add --pending to
the seed command. It replaces the sibling view with a message-capability
question; do not submit its answer. Omit --pending for affected captures.
Restart using the identical bootstrap-disabled command above. Pair through the
startup URL privately. Use real UI Settings for rich text and theme. Never send
the proof draft to a provider. A visited proof home records thread.visited events,
so reset with a NEW empty path, e.g. /tmp/issue-22997/after-rebuild: stop this
server, repeat the complete start/stop migration, seed and restart commands
above with after-rebuild in place of after-proof. Clear each browser draft
with Ctrl+A then Backspace in the editor. Do not reuse a visited database.
The default bootstrap MUST be disabled: it creates event history this script
refuses. Before comparison uses the same commands and a separate before-proof
home, running the pinned before checkout. Use a separate node_modules/.vite
cache for the before web app; sharing that cache causes Outdated Optimize Dep.

Schema: orchestration V2 (migration 67). No editor document is seeded. Freeze
the browser clock after every page reload, before opening comparison threads,
through preview_evaluate with this expression (does not change editor state):
  (()=>{const D=Date;const fixed=D.parse('2026-10-21T12:00:00.000Z');window.Date=class extends D {constructor(...a){super(...(a.length?a:[fixed]))}static now(){return fixed}};return new Date().toISOString()})()
The fixture fixes IDs and timestamps. Use UTC, wait for document.fonts.ready,
match viewport/theme/scroll and sidebar, and click a blank main-area point to
blur. Save preview_snapshot PNGs and retain recordings proving the key gestures.
Only use an empty proof home: this script deliberately refuses event history.
"""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

home = Path(sys.argv[1]).resolve()
if not str(home).startswith('/tmp/issue-22997/'):
    raise SystemExit('Proof homes must be under /tmp/issue-22997/')
fixture_path = Path(__file__).parent / 'fixtures/issue-22997.json'
fixture = json.loads(fixture_path.read_text())
db = home / 'userdata/statev2.sqlite'
if not db.is_file():
    raise SystemExit('Start and stop an isolated server to migrate its database first')
c = sqlite3.connect(db)
if c.execute('select count(*) from orchestration_events').fetchone()[0]:
    raise SystemExit('Refusing a database with event history; use a new proof home')
t = fixture['fixedClock']
pid = fixture['projectId']
with c:
    tables = [r[0] for r in c.execute("select name from sqlite_master where type='table' and name like 'orchestration_v2_projection_%'")]
    for table in tables:
        if table != 'orchestration_v2_projection_metadata':
            c.execute(f'DELETE FROM "{table}"')
    c.execute('delete from projection_projects')
    c.execute('insert into projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) values(?,?,?,?,?,?)', (pid,'Composer proof',str(Path(__file__).resolve().parents[1]),'[]',t,t))
    for thread in fixture['threads']:
        tid = thread['id']
        payload = dict(createdBy="user", creationSource="web", id=tid,projectId=pid,title=thread['title'],providerInstanceId='codex',modelSelection=dict(instanceId='codex',model='gpt-6.1-sol',options=[]),runtimeMode='full-access',interactionMode='default',branch=None,worktreePath=None,activeProviderThreadId=None,lineage=dict(parentThreadId=None,relationshipToParent=None,rootThreadId=tid),forkedFrom=None,createdAt=t,updatedAt=t,archivedAt=None,deletedAt=None,settledOverride='settled',settledAt=t)
        c.execute('insert into orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json,provider_instance_id) values(?,?,?,?,?,?,?,?,?,?)',(tid,pid,thread['title'],'codex','full-access','default',t,t,json.dumps(payload),'codex'))
        for ordinal, message in enumerate(thread['messages']):
            mid=f'{tid}-message-{ordinal}'
            payload=dict(createdBy="user", creationSource="web", id=mid,threadId=tid,runId=None,nodeId=None,role=message['role'],text=message['text'],attachments=[],streaming=False,createdAt=t,updatedAt=t)
            c.execute('insert into orchestration_v2_projection_messages values(?,?,?,?,?,?,?,?,?)',(mid,tid,None,None,message['role'],0,t,t,json.dumps(payload)))
            item=dict(createdBy="user", creationSource="web", id=f'{mid}-item',threadId=tid,runId=None,nodeId=None,providerThreadId=None,providerTurnId=None,nativeItemRef=None,parentItemId=None,ordinal=ordinal,status='completed',title=None,startedAt=t,completedAt=t,updatedAt=t,type=message['role']+'_message',messageId=mid,text=message['text'],attachments=[],streaming=False,inputIntent='turn_start')
            c.execute('insert into orchestration_v2_projection_turn_items values(?,?,?,?,?,?,?,?,?,?,?,?)',(item['id'],tid,None,None,None,None,None,ordinal,item['type'],'completed',t,json.dumps(item)))
    if '--pending' in sys.argv[2:]:
        tid = 'proof-22997-sibling'
        nid = 'proof-22997-question-node'
        rid = 'proof-22997-request'
        node = dict(id=nid,threadId=tid,runId=None,parentNodeId=None,rootNodeId=nid,kind='user_input_request',status='waiting',countsForRun=False,providerThreadId=None,providerTurnId=None,nativeItemRef=None,runtimeRequestId=rid,checkpointScopeId=None,startedAt=t,completedAt=None)
        c.execute('insert into orchestration_v2_projection_nodes values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(nid,tid,None,None,nid,'user_input_request','waiting',None,None,rid,None,t,None,json.dumps(node)))
        request = dict(id=rid,nodeId=nid,providerTurnId=None,nativeRequestRef=None,kind='user_input',status='pending',responseCapability=dict(type='message'),createdAt=t,resolvedAt=None)
        c.execute('insert into orchestration_v2_projection_runtime_requests values(?,?,?,?,?,?,?,?,?)',(rid,tid,nid,None,'user_input','pending',t,None,json.dumps(request)))
        item = dict(id='proof-22997-question-item',threadId=tid,runId=None,nodeId=nid,providerThreadId=None,providerTurnId=None,nativeItemRef=None,parentItemId=None,ordinal=0,status='waiting',title=None,startedAt=t,completedAt=None,updatedAt=t,type='user_input_request',requestId=rid,questions=[fixture['pendingQuestion']],responseMode='message')
        c.execute('insert into orchestration_v2_projection_turn_items values(?,?,?,?,?,?,?,?,?,?,?,?)',(item['id'],tid,None,nid,None,None,None,0,item['type'],'waiting',t,json.dumps(item)))
print(json.dumps(dict(seedId=fixture['seedId'],sha256=hashlib.sha256(fixture_path.read_bytes()).hexdigest(),database=str(db))))
