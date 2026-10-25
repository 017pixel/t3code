import { createMeshEnvironmentAtoms } from "@t3tools/client-runtime/state/mesh-status";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";

export const meshEnvironment = createMeshEnvironmentAtoms(connectionAtomRuntime, {
  serverConfigsAtom: environmentServerConfigsAtom,
});
