#!/usr/bin/env python3
"""Stopped-server ephemeral projection fixtures. No event history or provider execution."""
import argparse, json, pathlib, sqlite3
p=argparse.ArgumentParser()
p.add_argument('--home-dir',required=True)
p.add_argument('--server-stopped',action='store_true',required=True)
a=p.parse_args()
home=pathlib.Path(a.home_dir).resolve()
root=pathlib.Path(__file__).resolve().parents[5]
if not home.is_relative_to(root) or home == root or home == pathlib.Path.home()/'.t3':
    raise SystemExit('Use an explicit isolated home below this checkout')
db=home/'userdata/statev2.sqlite'
if not db.is_file(): raise SystemExit('Initialize isolated app first')
f=json.loads(pathlib.Path(__file__).with_name('messages.json').read_text())
project=home/'synthetic-project'
project.mkdir(exist_ok=True)
(project/'rtl-tasks.md').write_text(f['F2']+'\n\n'+f['F3'])
c=sqlite3.connect(db)
now='2026-01-01T00:00:00.000Z'
pid='rtl-proof-project'
with c:
 c.execute('INSERT OR REPLACE INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (?,?,?,?,?,?)',(pid,'RTL proof',str(project),'[]',now,now))
 for key in ['F1','F2','F3','F4','F5','F7','F8']:
  tid='rtl-proof-'+key+'-r3'
  thread=dict(createdBy='user',creationSource='web',id=tid,projectId=pid,title=key+' synthetic RTL proof',providerInstanceId='codex',modelSelection={'instanceId':'codex','model':'gpt-6-astra'},runtimeMode='full-access',interactionMode='default',branch=None,worktreePath=None,activeProviderThreadId=None,lineage={'rootThreadId':tid,'parentThreadId':None,'relationshipToParent':None},forkedFrom=None,createdAt=now,updatedAt=now,archivedAt=None,settledOverride=None,settledAt=None,lastVisitedAt=None,deletedAt=None)
  c.execute('INSERT OR REPLACE INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json,provider_instance_id) VALUES (?,?,?,?,?,?,?,?,?,?)',(tid,pid,thread['title'],'codex','full-access','default',now,now,json.dumps(thread),'codex'))
  c.execute('DELETE FROM orchestration_v2_projection_messages WHERE thread_id=?',(tid,))
  c.execute('DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id=?',(tid,))
  entries=[('user_message',f['F5'] if key=='F5' else 'Synthetic '+key+' fixture. No provider was run.'),('assistant_message',f.get(key,f['plan']))]
  if key=='F4': entries=[('assistant_message','[rtl-tasks.md](rtl-tasks.md)')]
  if key=='F7': entries=[('reasoning',f['thought']),('proposed_plan',f['plan']+'\n\n'+f['F2'])]
  if key=='F8': entries=[('compaction',f['context']),('error',f['context']),('reasoning',f['thought'])]
  for i,(kind,text) in enumerate(entries):
   item=dict(id=tid+'-item-'+str(i),threadId=tid,runId=None,nodeId=None,providerThreadId=None,providerTurnId=None,nativeItemRef=None,parentItemId=None,ordinal=i,status='completed',title=None,startedAt=now,completedAt=now,updatedAt=now,type=kind,text=text,streaming=False)
   if kind=='proposed_plan': item.update(planId=tid+'-plan',markdown=text)
   if kind=='compaction': item.update(driver=None,summary=text)
   if kind=='error': item.update(failure={'class':'unknown','message':text,'code':None,'retryable':False})
   if kind in ['user_message','assistant_message']:
    mid=tid+'-message-'+str(i)
    item.update(messageId=mid,attachments=[])
    if kind=='user_message': item.update(inputIntent='turn_start',createdBy='user',creationSource='web')
    m=dict(createdBy='user',creationSource='web',id=mid,threadId=tid,runId=None,nodeId=None,role='user' if kind=='user_message' else 'assistant',text=text,attachments=[],streaming=False,createdAt=now,updatedAt=now)
    c.execute('INSERT INTO orchestration_v2_projection_messages (message_id,thread_id,role,streaming,created_at,updated_at,payload_json) VALUES (?,?,?,?,?,?,?)',(mid,tid,m['role'],0,now,now,json.dumps(m)))
   c.execute('INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,ordinal,type,status,updated_at,payload_json) VALUES (?,?,?,?,?,?,?)',(item['id'],tid,i,kind,'completed',now,json.dumps(item)))
print('Seeded F1/F2/F3/F5/F7 projection fixtures and rtl-tasks.md; server must restart. No backend behavior claim.')
