#!/usr/bin/env python3
"""Emit a deterministic HTTP/RPC boundary fixture; never opens a database.

Run: python3 scripts/fixtures/issue-19208/seed.py > /tmp/menu-19208.json
Add --bootstrap to emit JavaScript for installation before app modules.
Set sessionStorage menu-19208-capture=true in the capture tab, then reload.
Add --workspace to create the disposable git workspace with real checkpoint refs. This proves client rendering,
not server orchestration or provider execution.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

f = json.loads(Path(__file__).with_name('fixture.json').read_text())
if '--workspace' in sys.argv:
    root = Path(f['workspaceRoot'])
    root.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, GIT_AUTHOR_DATE=f['clock'], GIT_COMMITTER_DATE=f['clock'])
    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args], env=env, stderr=subprocess.DEVNULL).decode().strip()
    if not (root / '.git').exists():
        git('init', '-b', 'synthetic-menu-proof')
        git('config', 'user.name', 'Synthetic Fixture')
        git('config', 'user.email', 'fixture@example.invalid')
        for n, greeting in enumerate(('Hello', 'Hello there', 'Hello, world')):
            (root / f['file']).write_text(f'export const greeting = "{greeting}";\n')
            git('add', f['file'])
            git('commit', '-m', f'Synthetic greeting {n}')
            if n: git('update-ref', f'refs/t3/checkpoints/menu-19208-{n}', 'HEAD')
    (root / f['file']).write_text('export const greeting = "Hello, reviewer";\n')
t = f['clock']
tid, pid = f['threadId'], f['projectId']
model = {'instanceId': 'codex', 'model': f['model']}
thread = dict(id=tid, projectId=pid, title=f['title'], providerInstanceId='codex',
              modelSelection=model, runtimeMode='full-access', interactionMode='default',
              branch='synthetic-menu-proof', worktreePath=None, activeProviderThreadId=None,
              lineage=dict(rootThreadId=tid, parentThreadId=None, relationshipToParent=None),
              forkedFrom=None, createdBy='user', creationSource='web', createdAt=t, updatedAt=t,
              archivedAt=None, settledOverride=None, settledAt=None, lastVisitedAt=t, deletedAt=None)
shell = dict(thread, latestRunId='menu-19208-run-2', activeRunId=None, status='completed',
             pendingRuntimeRequest=None, latestVisibleMessage=None, latestUserMessageAt=t,
             hasActionableProposedPlan=False, itemCount=4, visibleItemCount=4)
project = dict(id=pid, title='Menu proof workspace', workspaceRoot=f['workspaceRoot'],
               repositoryIdentity=None, defaultModelSelection=model, scripts=[], createdAt=t, updatedAt=t)
p = dict(thread=thread, updatedAt=t)
for key in ['runs','attempts','nodes','subagents','providerSessions','providerThreads','providerTurns',
            'runtimeRequests','messages','plans','turnItems','checkpointScopes','checkpoints',
            'contextHandoffs','contextTransfers','visibleTurnItems']:
    p[key] = []
for n in (1, 2):
    run, node, scope, cp = (f'menu-19208-{kind}-{n}' for kind in ('run','node','scope','checkpoint'))
    timestamp = f'2026-01-01T11:0{n}:00.000Z'
    p['runs'].append(dict(id=run, threadId=tid, ordinal=n, providerInstanceId='codex', modelSelection=model,
                          providerThreadId=None, userMessageId=f'menu-19208-user-{n}', rootNodeId=node,
                          activeAttemptId=None, status='completed', queuePosition=None, requestedAt=timestamp,
                          startedAt=timestamp, completedAt=timestamp, checkpointId=cp, contextHandoffId=None,
                          workspacePreparation={'type':'root'}))
    p['nodes'].append(dict(id=node, threadId=tid, runId=run, parentNodeId=None, rootNodeId=node,
                           kind='root_turn', status='completed', countsForRun=True, providerThreadId=None,
                           providerTurnId=None, nativeItemRef=None, runtimeRequestId=None,
                           checkpointScopeId=scope, startedAt=timestamp, completedAt=timestamp))
    p['checkpointScopes'].append(dict(id=scope, threadId=tid, runId=run, nodeId=node, parentScopeId=None,
                                      providerThreadId=None, kind='root_run', ordinalWithinParent=0,
                                      advancesAppRunCount=True, cwd=f['workspaceRoot'], createdAt=timestamp))
    p['checkpoints'].append(dict(id=cp, threadId=tid, scopeId=scope, runId=run, nodeId=node,
                                 parentCheckpointId=None, ordinalWithinScope=1, appRunOrdinal=n,
                                 ref=f'refs/t3/checkpoints/menu-19208-{n}', status='ready',
                                 files=[dict(path=f['file'],kind='modified',additions=1,deletions=1)], capturedAt=timestamp))
    for role, text in zip(('user','assistant'), f['messages']):
        mid = f'menu-19208-{role}-{n}'
        p['messages'].append(dict(id=mid, threadId=tid, runId=run, nodeId=node, role=role, text=text,
                                  attachments=[], streaming=False, createdBy='user' if role=='user' else 'agent',
                                  creationSource='web' if role=='user' else 'provider', createdAt=timestamp, updatedAt=timestamp))
        item = dict(id=f'{mid}-item',threadId=tid,runId=run,nodeId=node,providerThreadId=None,
                    providerTurnId=None,nativeItemRef=None,parentItemId=None,ordinal=len(p['turnItems']),
                    status='completed',title=None,startedAt=timestamp,completedAt=timestamp,updatedAt=timestamp,
                    type=f'{role}_message',messageId=mid,text=text)
        if role=='user': item.update(attachments=[],inputIntent='turn_start',createdBy='user',creationSource='web')
        else: item['streaming']=False
        p['turnItems'].append(item)
        p['visibleTurnItems'].append(dict(position=len(p['visibleTurnItems']),visibility='local',
                                           sourceThreadId=tid,sourceItemId=item['id'],item=item))
patch = 'diff --git a/example.ts b/example.ts\nindex 1111111..2222222 100644\n--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-export const greeting = "Hello";\n+export const greeting = "Hello, world";\n'
result = dict(clock=t,shell=dict(schemaVersion=1,snapshotSequence=0,projects=[project],threads=[shell],archivedThreads=[]),
                      detail=dict(snapshotSequence=0,projection=p),diff=patch)
encoded = json.dumps(result,sort_keys=True,indent=2)
if '--bootstrap' in sys.argv:
    print('globalThis.__menu19208Fixture=' + encoded + ';\n' + Path(__file__).with_name('replay.js').read_text())
else:
    print(encoded)
