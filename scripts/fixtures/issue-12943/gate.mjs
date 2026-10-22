import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [directory, action] = process.argv.slice(2);
if (!directory || !["ready", "append", "grow", "complete"].includes(action)) {
  throw new Error("Usage: node gate.mjs <gate-directory> ready|append|grow|complete");
}
const gates = NodePath.resolve(directory);
function waitFor(name) {
  return new Promise((done) => {
    const watcher = NodeFS.watch(gates, () => {
      if (NodeFS.existsSync(resolvePath())) {
        watcher.close();
        done();
      }
    });
    const resolvePath = () => NodePath.resolve(gates, name);
    if (NodeFS.existsSync(resolvePath())) {
      watcher.close();
      done();
    }
  });
}
await Promise.all([waitFor("chunk-buffered"), waitFor("response-buffered")]);
if (action !== "ready") {
  NodeFS.writeFileSync(NodePath.resolve(gates, action), "release\n");
  await waitFor(`${action}-released`);
}
console.log(`Fixture gate: ${action}`);
