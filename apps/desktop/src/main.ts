// Electron's entry stays separate from the code shared with lazy chunks.
// Effect's definition-site stacks add work for every schema/service import;
// restore runtime stacks before acquiring services or starting the app.
const stackTraceLimit = Error.stackTraceLimit;
let application: typeof import("./application.ts");
// A failure propagates as is: the crash dialog shows only the thrown error's
// stack, so a wrapper would hide the cause's message.
try {
  if (!process.env.VITE_DEV_SERVER_URL) Error.stackTraceLimit = 0;
  application = require("./application.cjs");
} finally {
  Error.stackTraceLimit = stackTraceLimit;
}
application.run();
