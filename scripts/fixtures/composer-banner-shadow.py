import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1]); c.row_factory=sqlite3.Row
r=c.execute('select * from orchestration_v2_projection_runs limit 1').fetchone(); run=json.loads(r['payload_json']); tid=r['thread_id']; pid=run['providerThreadId']
p=json.loads(c.execute('select payload_json from orchestration_v2_projection_provider_threads where provider_thread_id=?',(pid,)).fetchone()[0]);p['goal']={'objective':'Check the composer banners','status':'active','tokensUsed':1200,'tokenBudget':10000}
c.execute('update orchestration_v2_projection_provider_threads set payload_json=? where provider_thread_id=?',(json.dumps(p),pid))
t=json.loads(c.execute('select payload_json from orchestration_v2_projection_threads where thread_id=?',(tid,)).fetchone()[0]);t['title']='Composer banner shadow';t['settledAt']=None;t['settledOverride']=None
c.execute('update orchestration_v2_projection_threads set title=?,payload_json=? where thread_id=?',(t['title'],json.dumps(t),tid))
plan={'id':'issue-22819-tasks','threadId':tid,'runId':run['id'],'nodeId':run['rootNodeId'],'kind':'todo_list','status':'active','steps':[{'id':'one','text':'Inspect the banners','status':'completed'},{'id':'two','text':'Compare the shadow','status':'pending'},{'id':'three','text':'Capture the composer','status':'pending'}]}
c.execute('insert or replace into orchestration_v2_projection_plans values (?,?,?,?,?,?,?)',(plan['id'],tid,run['id'],plan['nodeId'],plan['kind'],plan['status'],json.dumps(plan)))
c.execute("update orchestration_v2_projection_messages set payload_json=json_set(payload_json, '$.text', 'Inspect the goal and task banners above the composer.') where thread_id=?", (tid,))
c.commit();print(tid)
