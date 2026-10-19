import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import { useClientSettings } from "~/hooks/useSettings";
import { FileSurfaceFailure, FileSurfaceLoading, FileSurfaceNotice } from "./fileSurfaceChrome";
import { type TextPreviewResult } from "./largeTextProtocol";
import VirtualTablePreview from "./VirtualTablePreview";

export default function LargeTextViewer(props: {
  readonly name: string;
  readonly src?: string;
  readonly text?: string;
  readonly copyContents?: RefObject<(() => Promise<string>) | null>;
  readonly delimiter: "," | "\t" | null;
}) {
  const [meta, setMeta] = useState<{ count: number; columns: number; complete: boolean } | null>(
    null,
  );
  const [pages, setPages] = useState(new Map<number, string[][]>());
  const [error, setError] = useState<string | null>(null);
  const worker = useRef<Worker | null>(null);
  const copyPending = useRef<{
    resolve: (text: string) => void;
    reject: (cause: Error) => void;
  } | null>(null);
  const pending = useRef(new Set<number>());
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  useEffect(() => {
    const engine = new Worker(new URL("./largeText.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.current = engine;
    engine.addEventListener("message", (event: MessageEvent<TextPreviewResult>) => {
      const result = event.data;
      if (result.type === "copy") {
        copyPending.current?.resolve(result.text);
        copyPending.current = null;
      } else if (result.type === "error") {
        if (copyPending.current) {
          copyPending.current.reject(new Error(result.message));
          copyPending.current = null;
        } else setError(result.message);
      } else if (result.type === "meta") setMeta(result);
      else if (result.type === "page") {
        pending.current.delete(result.index);
        setPages((old) => {
          const next = new Map(old);
          next.delete(result.index);
          next.set(result.index, result.rows);
          if (next.size > 12) next.delete([...next.keys()].find((key) => key !== 0)!);
          return next;
        });
      }
    });
    engine.addEventListener("error", () =>
      setError("Could not load the text viewer. Close the file and try again."),
    );
    engine.postMessage(
      {
        type: "open",
        src: props.src,
        text: props.text,
        delimiter: props.delimiter,
      },
      [],
    );
    return () => {
      copyPending.current?.reject(new Error("Preview closed."));
      copyPending.current = null;
      engine.terminate();
      worker.current = null;
      pending.current.clear();
    };
  }, [props.src, props.text, props.delimiter]);
  useImperativeHandle(
    props.copyContents,
    () => () =>
      new Promise<string>((resolve, reject) => {
        if (!worker.current) {
          reject(new Error("The file is unavailable."));
          return;
        }
        copyPending.current?.reject(new Error("Another copy is in progress."));
        copyPending.current = { resolve, reject };
        worker.current.postMessage({ type: "copy" }, []);
      }),
    [],
  );
  if (error) return <FileSurfaceFailure message={error} />;
  if (!meta || (meta.count > 0 && !pages.has(0))) return <FileSurfaceLoading />;
  const header = props.delimiter ? pages.get(0)?.[0] : undefined;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!meta.complete ? <FileSurfaceNotice>Loading the rest of the file…</FileSurfaceNotice> : null}
      {meta.columns === 1024 ? (
        <FileSurfaceNotice>
          Showing the first 1,024 columns. Source and Save retain every column.
        </FileSurfaceNotice>
      ) : null}
      <VirtualTablePreview
        name={props.name}
        count={meta.count}
        columns={meta.columns}
        header={header}
        source={!props.delimiter}
        wrap={wordWrap}
        getRows={(page) => pages.get(page)}
        loadPage={(page) => {
          if (pending.current.has(page)) return;
          pending.current.add(page);
          worker.current?.postMessage({ type: "page", index: page });
        }}
      />
      {meta.count === 0 ? (
        <p className="p-6 text-xs text-muted-foreground">This file is empty.</p>
      ) : null}
    </div>
  );
}
