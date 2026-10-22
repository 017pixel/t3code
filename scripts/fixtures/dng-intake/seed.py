#!/usr/bin/env python3
"""Reset stopped, disposable issue-16023 sandboxes to synthetic visual data.
Projection-only history is for rendering; upload/send must use actual app commands.
Never accepts the live T3 home. No copied conversation data is retained.
"""
import argparse, hashlib, json, pathlib, socket, sqlite3
p=argparse.ArgumentParser(); p.add_argument('worktree',type=pathlib.Path); a=p.parse_args()
root=a.worktree.resolve()
if root.name not in ('issue-16023','issue-16023-before') or root.parent != pathlib.Path('/home/ubuntu/wt'):
 raise ValueError('Only disposable issue-16023 sandboxes are accepted')
for port in (7840,15880,7492,15532):
 s=socket.socket(); s.settimeout(.2); result=s.connect_ex(('127.0.0.1',port)); s.close()
 if result == 0: raise RuntimeError(f'Stop isolated server on {port} first')
db=root/'.t3/userdata/statev2.sqlite'
if not db.is_file(): raise FileNotFoundError(db)
c=sqlite3.connect(db)
if c.execute("select 1 from orchestration_v2_effect_outbox where status in ('pending','running')").fetchone():
 c.close()
 raise RuntimeError("Sandbox has pending or running effects")
ts='2026-10-22T12:00:00.000Z'; project='dng-evidence-project'; populated='dng-evidence-populated'; empty='dng-evidence-empty'
# Clear disposable projections to prevent unrelated private history in sidebar/search.
with c:
 for (name,) in c.execute("select name from sqlite_master where type='table' and name like 'orchestration_v2_projection_%'").fetchall():
  if name != 'orchestration_v2_projection_metadata': c.execute('delete from '+name)
 c.execute('delete from projection_projects')
 c.execute('insert into projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at,auto_pull) values(?,?,?,?,?,?,0)',(project,'DNG attachment demo','/tmp/dng-evidence-workspace','[]',ts,ts))
 for thread,title in [(populated,'DNG original file delivery'),(empty,'Empty attachment demo')]:
  payload=dict(id=thread,projectId=project,title=title,createdBy='user',creationSource='web',providerInstanceId='codex',modelSelection=dict(instanceId='codex',model='gpt-6.1-sol'),runtimeMode='full-access',interactionMode='default',branch=None,worktreePath=None,pullRequests=[],activeProviderThreadId=None,lineage=dict(parentThreadId=None,relationshipToParent=None,rootThreadId=thread),forkedFrom=None,createdAt=ts,updatedAt=ts,archivedAt=None,settledOverride=None,settledAt=None,snoozedUntil=None,snoozedAt=None,lastVisitedAt=ts,deletedAt=None)
  c.execute('insert into orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json,provider_instance_id) values(?,?,?,?,?,?,?,?,?,?)',(thread,project,title,'codex','full-access','default',ts,ts,json.dumps(payload),'codex'))
 run='dng-evidence-run'
 payload=dict(id=run,threadId=populated,ordinal=1,providerInstanceId='codex',modelSelection=dict(instanceId='codex',model='gpt-6.1-sol'),providerThreadId=None,userMessageId='dng-evidence-message-0',rootNodeId=None,activeAttemptId=None,status='completed',requestedAt=ts,startedAt=ts,completedAt=ts,checkpointId=None,contextHandoffId=None)
 c.execute('insert into orchestration_v2_projection_runs values(?,?,?,?,?,?,?,?,?,?)',(run,populated,1,'codex',None,'completed',ts,ts,json.dumps(payload),'codex'))
 for i,(role,text) in enumerate([('user','Please keep the original camera file unchanged when I attach it.'),('assistant','Ready. Attach the DNG as a file. Its original bytes should remain unchanged.')]):
  mid=f'dng-evidence-message-{i}'
  payload=dict(id=mid,threadId=populated,runId=run,nodeId=None,role=role,text=text,attachments=[],streaming=False,createdAt=ts,updatedAt=ts,createdBy='user' if role=='user' else 'agent',creationSource='web' if role=='user' else 'provider')
  c.execute('insert into orchestration_v2_projection_messages values(?,?,?,?,?,?,?,?,?)',(mid,populated,run,None,role,0,ts,ts,json.dumps(payload)))
  item=dict(id=f'dng-evidence-item-{i}',threadId=populated,runId=run,nodeId=None,providerThreadId=None,providerTurnId=None,nativeItemRef=None,parentItemId=None,ordinal=i,status='completed',title=None,startedAt=ts,completedAt=ts,updatedAt=ts,type='user_message' if role=='user' else 'assistant_message',messageId=mid,text=text,attachments=[])
  if role=='user': item.update(createdBy='user',creationSource='web',inputIntent='turn_start')
  else: item['streaming']=False
  c.execute('insert into orchestration_v2_projection_turn_items values(?,?,?,?,?,?,?,?,?,?,?,?)',(item['id'],populated,run,None,None,None,None,i,item['type'],'completed',ts,json.dumps(item)))
rows={t:c.execute('select * from '+t+' order by 1').fetchall() for t in ['projection_projects','orchestration_v2_projection_threads','orchestration_v2_projection_messages','orchestration_v2_projection_runs','orchestration_v2_projection_runtime_requests','orchestration_v2_projection_turn_items']}
print(json.dumps(dict(seedHash=hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest(),threads=[populated,empty],environment=(root/'.t3/userdata/environment-id').read_text().strip())))
pathlib.Path('/tmp/dng-evidence-workspace').mkdir(exist_ok=True)
