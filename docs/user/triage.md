# Triage an issue

Triage lets your own coding agent investigate a T3 Code problem. The agent
reads the logs and state of the machine, checks the T3 Code source for that
version, finds known issues, and can help you write a good GitHub issue. It asks
before it changes anything or posts anything.

## In the app

Open the command palette and choose **Triage an issue**. T3 Code gets the source
for the server's version, then opens a new thread with no project. Choose any
provider, describe what went wrong below the prompt, and send.

Triage runs on the machine that you are looking at: the machine of the current
thread, or else your primary machine. The agent runs inside that T3 Code
server, so it gives you any restart steps and does not do them itself.

## In a terminal

If the app does not start, or triage does not work in the app, run:

```sh
npx t3 triage
```

It starts Claude Code or Codex in your terminal with the same instructions.
