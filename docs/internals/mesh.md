# Mesh (experimental)

Every environment linked to one T3 Connect account joins that account's mesh. Agents on
any member drive threads on every member, and clients reach every member through one
member, the **captain**. Shared shapes live in
[`contracts/src/mesh.ts`](../../packages/contracts/src/mesh.ts), captain choice in
[`shared/src/meshCaptain.ts`](../../packages/shared/src/meshCaptain.ts), and the server side
in [`apps/server/src/mesh`](../../apps/server/src/mesh). See
[remote access](../user/remote-access.md#mesh) for use.

## Trust model

A mesh has one owner, and members fully trust each other. The only thing that narrows a
call from another member is the calling agent's own modes: they travel in
`T3-Mesh-Mode-Limit` on every forwarded call, and the callee may narrow its modes to them
but never widen. A call without the header is refused.

Member-to-member sessions (`mesh-member`) hold only `orchestration:read` and are accepted
only on `/api/mesh/*` and `/mcp`. Writes on `/mcp` come from that subject plus the mode
limit, not from a wider scope, so a stolen session cannot reach the rest of `/api/*`.
Sessions are DPoP bound and come from a relay-signed grant the caller redeems directly
at the target; the relay never calls a member and never sees a session.

Membership checks use the member's authenticated key, not its environment id: another
account can link the same environment id with a different key. A key linked to more
than one Connect user joins no mesh. Leaving the mesh or a Connect account change revokes
every `mesh-member` session on that machine, and the others revoke the sessions of a
member that left.

## Relay and captain

The relay holds membership, presence, the captain, the pin, addresses and capabilities.
It holds no thread data. Agents call the owning member directly, over LAN, tailnet, then
the Connect tunnel, and never depend on the captain, so losing the captain never stops
agent work. The captain carries client traffic only.

Clients learn members, presence, captain and pin from one relay read (`GET /v1/mesh`)
per client, not from each member. The read follows events: start, sign-in, network
change, foreground, opening the Settings Mesh section, a captain refusal or demotion,
and, while a member is off its captain route, the existing better-route tick, which is
how a crashed captain's replacement is found. There is no mesh timer. Once the relay
answers that the account has no mesh, only a credential change or the Settings Mesh
section reads again, so accounts that never use it pay one read per start. A member's
`mesh.status` is the source only for that machine's own state (whether it left, its
role, its sessions); only the Settings Mesh section and its mutations read it.

## Why the captain is a stateless reverse proxy

The captain forwards whole requests and sockets: RPC, terminals, previews, uploads,
assets and device streams. Every client feature then works through it without gateway
code of its own, and nothing on the captain can go stale, because it keeps only via
handles and open connections. Merged views or caches on the captain would need their own
invalidation and authority.

The captain adds no credentials. Each member checks the client's own credential, so the
captain grants reachability, not access. The via handle in its URLs works the same way.
It is an HMAC of the Connect user id, keyed by a secret in the captain's secret store, and
the captain checks it by computing it again, so it keeps no handle table. It never
expires, so asset URLs stay valid across leases and captain restarts, and it rotates when
the captain leaves the mesh or changes Connect account. Only a `cloud-connect` session
can mint one; the desktop app on the captain machine keeps its direct routes.

Clients treat the captain route as one more route: when it fails, the route walk moves
each member to LAN, tailnet or Connect, and back later. The captain refuses a bad handle
or a member it cannot reach with `421`, never `401`, so a client cannot mistake it for
the member refusing its credential; the client reads the mesh again, which mints a new
handle, and skips the route. A demoted captain answers `410` and closes forwarded
sockets with `4102`; the client reads the mesh and reconnects without backoff.

A captain route exists only for members with a relay route. The client authorizes it
with the member's T3 Connect credential, and a member without a Connect URL has no URL
for proofs to name (below).

## The Host rule for proofs

A DPoP proof names the URL it signs, and a member rebuilds the request URL from `Host`
and `X-Forwarded-Proto` only. So the captain sends the member's Connect hostname as
`Host` and `https` as the protocol, and clients sign proofs for the member's Connect URL
(`proofBaseUrl`), never the captain's address. The proof then verifies whichever route
the captain uses to reach the member. Node's `fetch` ignores `Host` and the default
WebSocket constructor drops headers, which is why the captain uses a Node `http` client
and the `ws` package.

Two places name that URL, and they must agree. The client's proof base is the Connect
endpoint its token came with from the relay bootstrap, and the captain's `Host` is the
`connectHostname` the member sent in its relay hello. A member must report its managed
tunnel hostname there. Token refresh moves only the proof base; it never replaces a
captain route's request base with the tunnel URL.

The captain strips `Cookie`, `Set-Cookie` and client `X-Forwarded-*` headers: a member
reads a session cookie before DPoP, and client forwarded headers would change the URL
and origin a member checks.

## Client URL helpers keep a base path

A captain route's base URL has a path:
`<captain>/api/mesh/via/<handle>/<environmentId>`. Images, video, iframes, uploads and
stream sockets build their URLs from the connection's base URL outside the shared
`fetch`. A helper that resolves a root-absolute path such as `/api/assets/...` against
the origin drops that path and sends the request to the captain's own server. New URL
builders must join onto the base path; the builder test runs each one against a base
with a path.
