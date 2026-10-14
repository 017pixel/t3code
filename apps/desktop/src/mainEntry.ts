// Suppress Effect definition stacks only while production modules evaluate.
const stackTraceLimit = Error.stackTraceLimit;
let application: typeof import("./main.ts");
// Let errors propagate so Electron's crash dialog retains the cause.
try {
  if (!process.env.VITE_DEV_SERVER_URL) Error.stackTraceLimit = 0;
  application = require("./application.cjs");
} finally {
  Error.stackTraceLimit = stackTraceLimit;
}
application.run();
