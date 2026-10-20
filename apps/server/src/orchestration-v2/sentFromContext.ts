import type { OrchestrationV2MessageSentFrom } from "@t3tools/contracts";

const CLIENT_NAMES = {
  desktop: "the T3 Code desktop app",
  web: "a web browser",
  mobile: "the T3 Code mobile app",
  cli: "the T3 Code CLI",
} as const;

const LOOPBACK_HOSTNAME = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

function hostnameOf(host: string): string {
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "");
}

// Relay and SSH tunnels reach the server on loopback, so their route decides
// before the dialed host can.
function reachSentence(sentFrom: OrchestrationV2MessageSentFrom): string {
  if (sentFrom.connectionMethod === "relay" || sentFrom.connectionMethod === "ssh") {
    return " The user is probably not at this machine, so localhost URLs do not work for them.";
  }
  if (sentFrom.host === undefined) return "";
  const hostname = hostnameOf(sentFrom.host);
  return LOOPBACK_HOSTNAME.test(hostname)
    ? " The user is at this machine, so localhost URLs work for them."
    : ` The user is not at this machine. Use ${hostname} instead of localhost in URLs you give them.`;
}

/**
 * Tells the agent where the user is, so links it gives (dev servers, previews)
 * work from the user's device and "this machine" means the right one.
 */
export function formatSentFromContext(sentFrom: OrchestrationV2MessageSentFrom): string {
  const client =
    sentFrom.surface === undefined ? "a T3 Code client" : CLIENT_NAMES[sentFrom.surface];
  const os = sentFrom.os === undefined || sentFrom.os === "other" ? "" : ` on ${sentFrom.os}`;
  const device =
    sentFrom.deviceType === "phone" || sentFrom.deviceType === "tablet"
      ? ` (${sentFrom.deviceType})`
      : "";
  const machine =
    sentFrom.serverLabel === undefined ? "this machine" : `this machine (${sentFrom.serverLabel})`;
  const route =
    sentFrom.connectionMethod === "relay"
      ? " through T3 Connect"
      : sentFrom.connectionMethod === "ssh"
        ? " through an SSH tunnel"
        : sentFrom.host === undefined
          ? ""
          : ` at ${sentFrom.host}`;
  return `<sent_from>The user sent this message from ${client}${os}${device} to ${machine}${route}.${reachSentence(sentFrom)}</sent_from>`;
}
