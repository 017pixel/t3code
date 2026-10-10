import { showBootError } from "./lib/bootError";
import { restoreStackTraces, suspendStackTracesForAppImport } from "./lib/bootStackTraces";

// Bundled dev can move UI code into shared chunks. Load it only after this
// entry runs the React refresh preamble, and catch failures before React mounts.
suspendStackTracesForAppImport();
void import("./main")
  .then(({ startup }) => startup)
  .catch((error: unknown) => {
    restoreStackTraces();
    showBootError(error);
  });
