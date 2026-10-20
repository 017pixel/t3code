import { forkSession, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// Nothing here may run on import: inside the executable `import.meta.main` is
// true for the whole bundle.
const decodeHistoryOptions = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      dir: Schema.optionalKey(Schema.String),
      includeSystemMessages: Schema.optionalKey(Schema.Boolean),
      upToMessageId: Schema.optionalKey(Schema.String),
    }),
  ),
);

export async function runClaudeHistoryWorker(
  method: string | undefined,
  sessionId: string | undefined,
  rawOptions: string | undefined,
): Promise<void> {
  if (method === "pdfPageCount") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 20 * 1024 * 1024) throw new Error("PDF byte limit");
      chunks.push(chunk);
    }
    const { PDFDocument } = await import("pdf-lib");
    const document = await PDFDocument.load(Buffer.concat(chunks));
    process.stdout.write(JSON.stringify(document.getPageCount()));
    return;
  }
  const options = decodeHistoryOptions(rawOptions ?? "{}");
  if (!sessionId) throw new Error("Claude history session id is required.");
  const result =
    method === "getSessionMessages"
      ? await getSessionMessages(sessionId, options)
      : method === "forkSession"
        ? await forkSession(sessionId, options).then(async (forked) => {
            const headMessageId = await getSessionMessages(forked.sessionId, options)
              .then((messages) => messages.at(-1)?.uuid)
              .catch(() => undefined);
            return headMessageId === undefined ? forked : { ...forked, headMessageId };
          })
        : (() => {
            throw new Error("Unknown Claude history operation.");
          })();
  process.stdout.write(JSON.stringify(result));
}
