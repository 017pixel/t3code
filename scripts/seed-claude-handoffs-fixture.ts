import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

// Keep the fixture in sandbox state; never seed the running user's T3 home.
const root = NodePath.resolve(import.meta.dirname, "../.t3/repro-mod");
await NodeFSP.mkdir(NodePath.join(root, "hooks"), { recursive: true });
await NodeFSP.writeFile(NodePath.join(root, "hooks/hooks.json"), '{"modules":["./register.ts"]}\n');
await NodeFSP.writeFile(
  NodePath.join(root, "hooks/register.ts"),
  `import type { Register } from 'claude-code';
export const register: Register = on => {
 on('session.start', async ($, e, next) => {
  await $.command.register({name:'handoffs',description:'Issue 17418 fixture command'});
  return next(e);
 });
 on('command.run', {command:'handoffs'}, async () => ({text:'HANDOFFS_FIXTURE_OK'}));
};
`,
);
console.log(`Fixture: ${root}`);
console.log(`Start dev with CLAUDE_CODE_PLUGIN_DIRS=${root}, select Claude, then type /hand.`);
console.log("Select /handoffs and send; expect HANDOFFS_FIXTURE_OK.");
