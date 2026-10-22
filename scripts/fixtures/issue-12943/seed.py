import argparse
import datetime
import json
import sqlite3


parser = argparse.ArgumentParser()
parser.add_argument("database", help="Stopped, isolated development statev2.sqlite")
parser.add_argument("thread_id", help="Existing empty thread in that database")
args = parser.parse_args()
database = sqlite3.connect(args.database)
if not database.execute(
    "SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ?", (args.thread_id,)
).fetchone():
    raise SystemExit("Create the fixture thread in the app first")

with database:
    for index in range(120):
        message_id = f"selection-12943-{index}"
        role = "user" if index % 2 == 0 else "assistant"
        stamp = (
            datetime.datetime(2026, 10, 1, tzinfo=datetime.timezone.utc)
            + datetime.timedelta(minutes=index)
        ).isoformat().replace("+00:00", "Z")
        message = dict(
            id=message_id, threadId=args.thread_id, runId=None, nodeId=None,
            role=role, text=f"test {index} — Selection fixture message with enough words to drag across the conversation.",
            attachments=[], streaming=False, createdAt=stamp, updatedAt=stamp,
            createdBy="user", creationSource="web",
        )
        database.execute(
            "INSERT OR REPLACE INTO orchestration_v2_projection_messages VALUES (?,?,?,?,?,?,?,?,?)",
            (message_id, args.thread_id, None, None, role, 0, stamp, stamp, json.dumps(message)),
        )
        item = dict(
            id=message_id + "-item", threadId=args.thread_id, runId=None, nodeId=None,
            providerThreadId=None, providerTurnId=None, nativeItemRef=None, parentItemId=None,
            ordinal=index, status="completed", title=None, startedAt=stamp,
            completedAt=stamp, updatedAt=stamp, type=role + "_message",
            messageId=message_id, text=message["text"], streaming=False,
        )
        if role == "user":
            item.update(createdBy="user", creationSource="web", inputIntent="turn_start", attachments=[])
        database.execute(
            "INSERT OR REPLACE INTO orchestration_v2_projection_turn_items "
            "(turn_item_id,thread_id,run_id,node_id,provider_thread_id,provider_turn_id,parent_item_id,ordinal,type,status,updated_at,payload_json) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (item["id"], args.thread_id, None, None, None, None, None, index,
             item["type"], "completed", stamp, json.dumps(item)),
        )
print("Seeded 120 alternating messages; open in a fresh browser profile to avoid cached history")
