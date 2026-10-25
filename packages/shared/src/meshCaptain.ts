import type {
  EnvironmentId,
  EnvironmentMachineKind,
  MeshCapabilities,
  MeshIneligibleReason,
  MeshScoreInputs,
} from "@t3tools/contracts";

/** What the relay knows about a member when it picks the captain. */
export interface MeshCaptainCandidate {
  readonly environmentId: EnvironmentId;
  readonly online: boolean;
  readonly capabilities: MeshCapabilities;
  readonly score: MeshScoreInputs;
}

/** Why an online member cannot be captain, or undefined when it can. Offline gives undefined too. */
export function meshCaptainIneligibleReason(
  candidate: MeshCaptainCandidate,
): MeshIneligibleReason | undefined {
  if (candidate.capabilities.meshGateway === undefined) return "needs-update";
  if (!candidate.capabilities.meshGateway) return "not-gateway";
  if (!candidate.score.tunnelReady) return "no-tunnel";
  return undefined;
}

export function isMeshCaptainEligible(candidate: MeshCaptainCandidate): boolean {
  return candidate.online && meshCaptainIneligibleReason(candidate) === undefined;
}

// Dedicated machines first, laptops last; WSL ("linux") and unknown kinds sit just above laptops.
const MACHINE_KIND_RANK: Readonly<Record<EnvironmentMachineKind, number>> = {
  server: 0,
  cloud: 1,
  "mac-mini": 2,
  "mac-studio": 3,
  desktop: 4,
  linux: 5,
  laptop: 7,
};
const UNKNOWN_MACHINE_KIND_RANK = 6;

const isPowerConstrained = (score: MeshScoreInputs) =>
  score.onBattery === "true" || score.lowPowerMode === "true";

const startedAtMs = (score: MeshScoreInputs) => {
  const parsed = Date.parse(score.startedAt);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
};

/** Negative when `a` ranks above `b`. */
function compareCandidates(a: MeshCaptainCandidate, b: MeshCaptainCandidate): number {
  const byService = Number(b.score.backgroundService) - Number(a.score.backgroundService);
  if (byService !== 0) return byService;
  const byPower = Number(isPowerConstrained(a.score)) - Number(isPowerConstrained(b.score));
  if (byPower !== 0) return byPower;
  const kindRank = (candidate: MeshCaptainCandidate) =>
    candidate.score.machineKind === null
      ? UNKNOWN_MACHINE_KIND_RANK
      : MACHINE_KIND_RANK[candidate.score.machineKind];
  const byKind = kindRank(a) - kindRank(b);
  if (byKind !== 0) return byKind;
  const byUptime = startedAtMs(a.score) - startedAtMs(b.score);
  if (byUptime !== 0) return byUptime;
  return a.environmentId < b.environmentId ? -1 : a.environmentId > b.environmentId ? 1 : 0;
}

/**
 * Picks the captain among eligible members. An eligible pin wins. Otherwise the current captain
 * stays while it is eligible, so a better member joining does not move client traffic. Otherwise
 * the best ranked: background service, then not on battery or low power, then machine kind,
 * then longest uptime, then lowest environment id.
 */
export function chooseCaptain(
  members: ReadonlyArray<MeshCaptainCandidate>,
  pin: EnvironmentId | null,
  currentCaptain: EnvironmentId | null,
): EnvironmentId | null {
  const eligible = members.filter(isMeshCaptainEligible);
  if (pin !== null && eligible.some((member) => member.environmentId === pin)) return pin;
  if (
    currentCaptain !== null &&
    eligible.some((member) => member.environmentId === currentCaptain)
  ) {
    return currentCaptain;
  }
  return eligible.sort(compareCandidates)[0]?.environmentId ?? null;
}
