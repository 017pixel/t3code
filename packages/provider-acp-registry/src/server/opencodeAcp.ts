/**
 * OpenCode 2 over ACP advertises only commands, never the skills it loads, so
 * T3 scans the roots OpenCode 2 reads: `.agents/skills` and `.claude/skills`
 * (compatibility), and `opencode/skill(s)` config directories, globally and in
 * every directory from the workspace up. Skills named in `opencode.json` and
 * plugin-provided skills are not listed.
 */

import type { ServerProviderSkill } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYamlDocument } from "yaml";

export const OPENCODE_V2_AGENT_ID = "opencode-v2";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
// OpenCode stops descending at depth 6 and skips dot-directories.
const MAX_SKILL_DEPTH = 6;
const MAX_SKILL_BYTES = 1_000_000;
const MAX_SCAN_ENTRIES = 10_000;
const IGNORED_DIRECTORIES = new Set(["node_modules"]);

const isTruthyFlag = (value: string | undefined) =>
  value !== undefined && ["1", "true"].includes(value.trim().toLowerCase());

const readDescription = (contents: string): string | undefined => {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) return undefined;
  try {
    const parsed: unknown = parseYamlDocument(match[1] ?? "");
    if (typeof parsed !== "object" || parsed === null || !("description" in parsed)) {
      return undefined;
    }
    const description = parsed.description;
    return typeof description === "string" && description.trim() ? description.trim() : undefined;
  } catch {
    return undefined;
  }
};

export const discoverOpenCodeAcpSkills = Effect.fn("discoverOpenCodeAcpSkills")(function* (
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home =
    environment.HOME?.trim() ||
    environment.USERPROFILE?.trim() ||
    (yield* HostProcess.HomeDirectory);
  const configHome = environment.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  const includeClaude = !(
    isTruthyFlag(environment.OPENCODE_DISABLE_CLAUDE_CODE) ||
    isTruthyFlag(environment.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS)
  );
  const compatibilityRoots = (base: string) => [
    path.join(base, ".agents", "skills"),
    ...(includeClaude ? [path.join(base, ".claude", "skills")] : []),
  ];
  const configRoots = (base: string) => [path.join(base, "skill"), path.join(base, "skills")];

  const roots: Array<string> = [];
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    roots.push(...compatibilityRoots(directory), ...configRoots(path.join(directory, ".opencode")));
    if (path.dirname(directory) === directory) break;
  }
  roots.push(...compatibilityRoots(home), ...configRoots(path.join(configHome, "opencode")));

  const orUndefined = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.orElseSucceed(() => undefined));
  let remainingEntries = MAX_SCAN_ENTRIES;
  const scannedRoots = new Set<string>();
  const skills = new Map<string, ServerProviderSkill>();
  const addSkill = Effect.fn("addOpenCodeAcpSkill")(function* (name: string, skillPath: string) {
    if (!name || skills.has(name)) return;
    const info = yield* orUndefined(fileSystem.stat(skillPath));
    if (info?.type !== "File") return;
    const contents =
      info.size <= MAX_SKILL_BYTES
        ? yield* orUndefined(fileSystem.readFileString(skillPath))
        : undefined;
    const description = contents === undefined ? undefined : readDescription(contents);
    skills.set(name, {
      name,
      path: skillPath,
      enabled: true,
      ...(description ? { description } : {}),
    });
  });

  for (const root of roots) {
    const realRoot = yield* orUndefined(fileSystem.realPath(root));
    if (!realRoot || scannedRoots.has(realRoot)) continue;
    scannedRoots.add(realRoot);
    const queue = [{ directory: realRoot, depth: 0 }];
    for (const { directory, depth } of queue) {
      if (remainingEntries <= 0) break;
      const entries = yield* orUndefined(fileSystem.readDirectory(directory));
      if (!entries) continue;
      const visible = entries
        .filter((entry) => !entry.startsWith(".") && !IGNORED_DIRECTORIES.has(entry))
        .toSorted()
        .slice(0, remainingEntries);
      remainingEntries -= visible.length;
      if (visible.includes("SKILL.md")) {
        yield* addSkill(path.basename(directory), path.join(directory, "SKILL.md"));
        continue;
      }
      for (const entry of visible) {
        const child = path.join(directory, entry);
        if (depth === 0 && entry.endsWith(".md")) {
          yield* addSkill(entry.slice(0, -".md".length), child);
          continue;
        }
        if (depth >= MAX_SKILL_DEPTH) continue;
        const info = yield* orUndefined(fileSystem.stat(child));
        if (info?.type === "Directory") queue.push({ directory: child, depth: depth + 1 });
      }
    }
  }
  return [...skills.values()].toSorted((left, right) => left.name.localeCompare(right.name));
});
