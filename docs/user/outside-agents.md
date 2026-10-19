# Outside agents

Agents that T3 Code did not start can work with an environment through its MCP
server. They can read projects and threads, start and message threads, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal, ChatGPT, and bots that support MCP. Each agent signs
in once, and you choose what it may do.

## Get the MCP URL

In **Settings → Connections**, open a saved environment's menu and choose
**Copy MCP URL**. The URL is the environment's address followed by `/mcp`, for
example:

```text
https://<environment-address>/mcp
```

The copied URL uses the route this device is connected over, so an agent on the
same device can reach it.

- **An agent on your own computers** can use any address that computer reaches
  the environment at: a LAN or Tailscale address, T3 Connect, or `localhost` on
  the host. See [remote access](./remote-access.md).
- **A hosted agent**, such as ChatGPT or a bot running in the cloud, must reach
  the environment from the internet. Use the T3 Connect address. A Tailscale
  address only works from your own tailnet.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on the environment.
The page names the agent and where its access goes:

- For an agent on your computer, approval returns to a `localhost` address on
  the computer that opened the page.
- For a hosted agent, approval goes to that service, such as `chatgpt.com`.
  Anyone who runs that service gets the access.

Only approve a sign-in you just started. To approve, enter a pairing code from
**Settings → Connections** or from `t3 auth pairing create` on the host. A
browser already signed in to the environment with permission to manage access
can approve without a code.

Then choose what the agent may do:

- **Read only** is the default. The agent can read projects and threads and see
  the available providers and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

## Claude Code

```sh
claude mcp add --transport http t3 https://<environment-address>/mcp
claude mcp login t3
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `t3` as connected
once you approve.

## Codex

```sh
codex mcp add t3 --url https://<environment-address>/mcp
codex mcp login t3
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `t3` with OAuth once you approve.

## ChatGPT

Add the environment as a custom MCP app in ChatGPT's apps settings:

1. Create a new app or plugin with a custom MCP server.
2. Set the server URL to `https://<environment-address>/mcp`, using the T3
   Connect address.
3. Choose **OAuth** for authentication. ChatGPT discovers the rest; you do not
   need a client ID or secret.
4. Create the app, then approve the sign-in page that opens.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support cannot connect.

## Link from another T3 Code environment

On the host that will make requests, link the other environment with a pairing
code from its **Settings → Connections** or `t3 auth pairing create`:

```sh
t3 environment link https://<environment-address> --pairing-code <code> --access approval-required
```

Use HTTPS, or HTTP with a loopback address, a Tailscale `.ts.net` name, or a
Tailscale IPv6 address. Plain HTTP LAN and Tailscale IPv4 addresses are not
supported. The link belongs to the host where you ran the command and
appears on the peer as **T3 Code · <host label>**. Calls keep both the link's
access ceiling and the calling agent's narrower modes.

Use `t3 environment list` to check reachability and
`t3 environment get <environment-id> --json` to read a stored link without
contacting the peer. Run `t3 environment unlink <environment-id>` to forget it
locally. To revoke its access on the peer, remove its session in that peer's
Connections settings. After a link expires, link again with a new pairing code.

Agents can call `t3_environment_links`, then pass a listed `environmentId` to
tools that accept it. Projects, threads, runs, providers and models must come
from that destination; supply thread or project IDs explicitly. This includes
project creation, thread launch/read/send/wait, queues, pending requests and
ordinary scheduling. `delegate_task` stays local.

Remote launches cannot carry attachments. Remote schedules cannot use a
`signature.secretRef` created here; configure signed webhooks from a thread
in the destination instead. Waits use requests of at most 50 seconds and keep
following the originally selected run.

`t3_thread_interrupt` with `stop:true` also holds the queue, ends pull request
watches and stops delegated work. A partial retry can hold the current queue
and end current watches on the original still-current run; it does not stop
later-created runs or descendants. `interrupt_requested` confirms acceptance,
not termination. Older peers that ignore `stop` only interrupt the run.

## Remove an agent

Approved agents appear under **Settings → Connections** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.
