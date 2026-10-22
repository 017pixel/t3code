"""Export only public fixture messages, opening the explicit isolated database read-only."""
import argparse
import json
import pathlib
import sqlite3

parser = argparse.ArgumentParser()
parser.add_argument("home", type=pathlib.Path)
args = parser.parse_args()
home = args.home.resolve()
if not home.is_relative_to(pathlib.Path('/tmp/issue-10056-evidence')):
    raise SystemExit('Refusing a non-evidence home')
connection = sqlite3.connect((home / 'userdata/statev2.sqlite').as_uri() + '?mode=ro', uri=True)
messages = []
for (payload,) in connection.execute(
    "SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id LIKE 'issue10056-%'"
):
    message = json.loads(payload)
    messages.append({key: message.get(key) for key in ('id', 'threadId', 'text', 'context')})
print(json.dumps(messages, indent=2, ensure_ascii=True))
