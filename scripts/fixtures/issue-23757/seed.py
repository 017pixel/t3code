#!/usr/bin/env python3
"""Neutral visual projections. Stop the isolated proof server before running.

Requires a fresh migrated home with scratch created and renamed through the app.
These stopped thread projections test rendering, not event history or provider execution.
"""
import argparse,json,pathlib,sqlite3
p=argparse.ArgumentParser();p.add_argument('--home',required=True);a=p.parse_args()
home=pathlib.Path(a.home).resolve()
if not str(home).startswith('/tmp/issue-23757-'): raise SystemExit('Use a dedicated /tmp/issue-23757-* home')
c=sqlite3.connect(home/'userdata/statev2.sqlite')
scratch=c.execute('select project_id from projection_projects where workspace_root=?',(str(home/'scratch'),)).fetchone()
if not scratch: raise SystemExit('Create scratch through the app first')
pid=scratch[0]; now='2026-10-22T20:00:00.000Z'
# Keep the app-created saved title/icon; replace only the neutral display fixtures.
ordinary=pathlib.Path('/tmp/issue-23757-ordinary');ordinary.mkdir(exist_ok=True)
c.execute("update projection_projects set title='Example project',workspace_root=?,favicon_path=NULL,created_at=?,updated_at=? where project_id!=?",(str(ordinary),now,now,pid))
row=c.execute('select payload_json from orchestration_v2_projection_threads limit 1').fetchone()
template=json.loads(row[0]); c.execute('delete from orchestration_v2_projection_threads')
for tid,title,parent in [('proof-parent','Planning a neutral example with a deliberately long parent breadcrumb',None),('proof-child','Review the sample layout','proof-parent')]:
 d=dict(template,id=tid,projectId=pid,title=title,branch=None,worktreePath=None,createdAt=now,updatedAt=now,lastVisitedAt=now,createdBy='user',creationSource='web',lineage=dict(parentThreadId=parent,relationshipToParent='subagent' if parent else None,rootThreadId='proof-parent'))
 c.execute('insert into orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json,provider_instance_id) values(?,?,?,?,?,?,?,?,?,?)',(tid,pid,title,'codex','full-access','default',now,now,json.dumps(d),'codex'))
c.commit();c.close()
print(json.dumps(dict(clock=now,home=str(home),scratchProjectId=pid,threads=['proof-parent','proof-child'])))
