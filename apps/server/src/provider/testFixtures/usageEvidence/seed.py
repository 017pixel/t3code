#!/usr/bin/env python3
"""Seed an initialized, stopped, disposable worktree .t3; never use production userdata."""
import json, pathlib, sqlite3, subprocess, sys
root=pathlib.Path.cwd().resolve()
base=root/'.t3/userdata'
if not (root/'.git').is_file() or base.resolve()!=base or base.resolve()==(pathlib.Path.home()/'.t3/userdata').resolve():
    raise SystemExit('Run from an isolated worktree with its server stopped')
git=subprocess.run(['git','rev-parse','--path-format=absolute','--show-toplevel','--git-dir','--git-common-dir'],capture_output=True,text=True)
paths=git.stdout.splitlines()
if git.returncode or len(paths)!=3 or pathlib.Path(paths[0]).resolve()!=root or paths[1]==paths[2]:
    raise SystemExit('Run from an isolated worktree with its server stopped')
scenario=sys.argv[1]
if scenario not in ['S1','S2','S3','R1','R2','R3']: raise SystemExit('Unknown scenario')
fixture=pathlib.Path(__file__).resolve().parent
home=base/'usage-evidence-empty-home'; home.mkdir(exist_ok=True)
config={'homePath':str(home),'binaryPath':'codex','launchArgs':'-c model_providers.cliproxy.name="cliproxy" -c model_providers.cliproxy.base_url="http://127.0.0.1:8317/v1" -c model_providers.cliproxy.env_key="ANTHROPIC_AUTH_TOKEN" -c model_providers.cliproxy.wire_api="responses" -c model_provider="cliproxy"'}
if scenario in ['S3','R2','R3']:
    config={'homePath':str(home),'binaryPath':str(fixture/'peer.mjs')}
settings={'projectSettingsFolded':True,'providerInstances':{'codex':{'driver':'codex','displayName':'Codex (via cliproxy)' if scenario in ['S1','S2','R1'] else 'Codex (protocol fixture)','config':config},'claudeAgent':{'driver':'claudeAgent','enabled':False}}}
if scenario in ['S2','R1']:
    settings['usageLimitSources']={'evidence-proxy':{'kind':'cliproxy','url':'http://127.0.0.1:18317','managementKey':'public-evidence-dummy-key','enabled':True,'label':'Demo proxy source'}}
(base/'settings.json').write_text(json.dumps(settings,indent=2)+'\n')
control=pathlib.Path('/tmp/issue-11873-evidence/control.json');control.parent.mkdir(exist_ok=True)
control.write_text(json.dumps({'scenario':scenario,'phase':'auth' if scenario=='R3' else 'success'}))
c=sqlite3.connect(base/'statev2.sqlite')
# Only projection context is seeded; provider responses still traverse the live RPC boundary.
for (name,) in c.execute("select name from sqlite_schema where type='table'").fetchall():
    if name.startswith('orchestration_v2_projection_') or name.startswith('projection_thread'):
        c.execute('DELETE FROM "'+name+'"')
c.execute('DELETE FROM projection_projects')
t='2026-10-22T12:00:00.000Z'
c.execute('INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',('evidence-project','Usage evidence',str(root),'[]',t,t))
payload={'createdBy':'user','creationSource':'web','lineage':{'parentThreadId':None,'relationshipToParent':None,'rootThreadId':'evidence-thread'},'id':'evidence-thread','projectId':'evidence-project','title':'Usage comparison','providerInstanceId':'codex','modelSelection':{'instanceId':'codex','model':'gpt-5.4'},'runtimeMode':'full-access','interactionMode':'default','branch':None,'worktreePath':None,'activeProviderThreadId':None,'createdAt':t,'updatedAt':t,'archivedAt':None,'deletedAt':None,'forkedFrom':None}
c.execute('INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json,provider_instance_id) VALUES(?,?,?,?,?,?,?,?,?,?)',('evidence-thread','evidence-project','Usage comparison','codex','full-access','default',t,t,json.dumps(payload),'codex'))
c.commit();c.close()
