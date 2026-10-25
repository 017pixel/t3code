import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { TextLayer, type PDFDocumentProxy } from "pdfjs-dist";
import { ChevronDownIcon, ChevronUpIcon, MinusIcon, PlusIcon, ScanIcon } from "lucide-react";
import { Input } from "~/components/ui/input";
import { observeResize } from "~/lib/observeResize";
import { FileSurfaceAction, FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";
import { readBoundedDocument } from "./readBoundedDocument";
import { openPdf } from "./pdfDocument";
import "./pdfViewer.css";

const MAX_PAGES = 2000;
const MAX_FIND_TEXT = 4 * 1024 * 1024;

function PdfPage(props: {
  document: PDFDocumentProxy;
  index: number;
  width: number;
  query: string;
  onSize: (index: number, ratio: number) => void;
  onError: (error: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const { document: pdf, index, width, onSize, onError } = props;
  useEffect(() => {
    let cancelled = false;
    let paint: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    let layer: TextLayer | undefined;
    let loadedPage: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | undefined;
    void (async () => {
      const page = await pdf.getPage(index + 1);
      loadedPage = page;
      if (cancelled || !canvas.current || !text.current) {
        page.cleanup();
        return;
      }
      const natural = page.getViewport({ scale: 1 });
      onSize(index, natural.height / natural.width);
      const viewport = page.getViewport({ scale: width / natural.width });
      const ratio = Math.min(
        2,
        window.devicePixelRatio || 1,
        Math.sqrt((8 * 1024 * 1024) / (viewport.width * viewport.height)),
      );
      canvas.current.width = Math.ceil(viewport.width * ratio);
      canvas.current.height = Math.ceil(viewport.height * ratio);
      paint = page.render({
        canvas: canvas.current,
        viewport,
        transform: [ratio, 0, 0, ratio, 0, 0],
        background: "white",
      });
      text.current.replaceChildren();
      text.current.style.setProperty("--total-scale-factor", String(viewport.scale));
      layer = new TextLayer({
        container: text.current,
        viewport,
        textContentSource: page.streamTextContent(),
      });
      await Promise.all([paint.promise, layer.render()]);
    })().catch((cause: unknown) => {
      if (!cancelled)
        onError(cause instanceof Error ? cause.message : "This PDF page could not render.");
    });
    return () => {
      cancelled = true;
      paint?.cancel();
      layer?.cancel();
      // Release operator lists when virtual pages leave the viewport.
      void Promise.allSettled([paint?.promise]).then(() => loadedPage?.cleanup());
    };
  }, [pdf, index, width, onSize, onError]);
  useEffect(() => {
    const node = text.current;
    if (!node) return;
    const mark = () => {
      for (const span of node.querySelectorAll("span"))
        span.classList.toggle(
          "pdf-find-match",
          Boolean(
            props.query && span.textContent?.toLowerCase().includes(props.query.toLowerCase()),
          ),
        );
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(node, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [props.query]);
  return (
    <>
      <canvas ref={canvas} aria-label={`Page ${index + 1}`} className="block h-full w-full" />
      <div ref={text} data-pdf-text-layer />
    </>
  );
}

export default function PdfViewer(props: { src: string; title: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [ratios, setRatios] = useState<number[]>([]);
  const [zoom, setZoom] = useState<number | null>(null);
  const [pageWidth, setPageWidth] = useState(612);
  const [viewport, setViewport] = useState({ width: 600, height: 800 });
  const [scrollTop, setScrollTop] = useState(0);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<number[]>([]);
  const [finding, setFinding] = useState(false);
  const [match, setMatch] = useState(0);
  const scroll = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let task: ReturnType<typeof openPdf> | undefined;
    const timeout = setTimeout(() => {
      setError("This PDF took too long to load. Try again.");
      controller.abort();
      void task?.destroy();
    }, 30_000);
    void readBoundedDocument(
      props.src,
      controller.signal,
      50 * 1024 * 1024,
      revision > 0 ? "reload" : "default",
    )
      .then(async (bytes) => {
        controller.signal.throwIfAborted();
        task = openPdf(bytes);
        const document = await task.promise;
        if (document.numPages > MAX_PAGES)
          throw new Error("Preview limited to 2,000 pages. Save this PDF to read it in full.");
        const first = (await document.getPage(1)).getViewport({ scale: 1 });
        if (controller.signal.aborted) return;
        setPageWidth(first.width);
        setRatios(Array.from({ length: document.numPages }, () => first.height / first.width));
        setPdf(document);
      })
      .catch((cause: unknown) => {
        if (!disposed && !controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Unable to open PDF.");
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timeout);
      void task?.destroy();
    };
  }, [props.src, revision]);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const update = () => setViewport({ width: node.clientWidth, height: node.clientHeight });
    update();
    return observeResize(node, update);
  }, []);
  const fitWidth = Math.max(1, viewport.width - 32);
  const scale = zoom ?? fitWidth / pageWidth;
  const width = zoom === null ? fitWidth : pageWidth * zoom;
  const offsets = (() => {
    const result = [16];
    for (const ratio of ratios) result.push(result[result.length - 1]! + width * ratio + 16);
    return result;
  })();
  const current = ratios.reduce((best, ratio, index) => {
    const visibleHeight = (page: number, pageRatio: number) =>
      Math.max(
        0,
        Math.min(offsets[page]! + width * pageRatio, scrollTop + viewport.height) -
          Math.max(offsets[page]!, scrollTop),
      );
    return visibleHeight(index, ratio) > visibleHeight(best, ratios[best]!) + 1 ? index : best;
  }, 0);
  const visible = ratios.flatMap((ratio, index) =>
    offsets[index + 1]! >= scrollTop - viewport.height &&
    offsets[index]! <= scrollTop + viewport.height * 2
      ? [{ index, ratio }]
      : [],
  );
  // Stable callbacks let page canvases survive scroll and find updates.
  const [onSize] = useState(
    () => (index: number, ratio: number) =>
      setRatios((old) =>
        old[index] === ratio ? old : old.map((value, i) => (i === index ? ratio : value)),
      ),
  );
  const jumpToPage = useEffectEvent((index: number) => {
    scroll.current?.scrollTo({ top: Math.max(0, (offsets[index] ?? 16) - 16) });
  });
  const showPage = (index: number) => {
    scroll.current?.scrollTo({ top: Math.max(0, (offsets[index] ?? 16) - 16) });
  };
  useEffect(() => {
    if (!pdf || !query.trim()) {
      // oxlint-disable-next-line react/set-state-in-effect -- A blank query cancels the previous search.
      setFinding(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setFinding(true);
      setMatches([]);
      setMatch(0);
      void (async () => {
        const found: number[] = [];
        let size = 0;
        for (let index = 0; index < pdf.numPages; index++) {
          if (cancelled) return;
          const content = await (await pdf.getPage(index + 1)).getTextContent();
          const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
          size += text.length;
          if (size > MAX_FIND_TEXT)
            throw new Error(
              "This PDF has too much text to search. Save it to search in another app.",
            );
          if (text.toLowerCase().includes(query.toLowerCase())) found.push(index);
        }
        if (cancelled) return;
        setMatches(found);
        if (found.length) jumpToPage(found[0]!);
      })()
        .catch((cause: unknown) => {
          if (!cancelled)
            setError(cause instanceof Error ? cause.message : "Could not search this PDF.");
        })
        .finally(() => {
          if (!cancelled) setFinding(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pdf, query]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1 text-xs">
        <span className="mr-auto px-1 tabular-nums" aria-live="polite">
          {pdf ? `${current + 1} / ${pdf.numPages} pages` : "PDF"}
        </span>
        <FileSurfaceAction
          label="Previous page"
          disabled={!pdf || current === 0}
          onPress={() => showPage(current - 1)}
        >
          <ChevronUpIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Next page"
          disabled={!pdf || current + 1 >= pdf.numPages}
          onPress={() => showPage(current + 1)}
        >
          <ChevronDownIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Zoom out"
          disabled={scale <= 0.25}
          onPress={() => setZoom(Math.max(0.25, scale - 0.25))}
        >
          <MinusIcon className="size-3.5" />
        </FileSurfaceAction>
        <span className="min-w-14 text-center tabular-nums">
          {zoom === null ? "Fit width" : `${Math.round(scale * 100)}%`}
        </span>
        <FileSurfaceAction
          label="Zoom in"
          disabled={scale >= 3}
          onPress={() => setZoom(Math.min(3, scale + 0.25))}
        >
          <PlusIcon className="size-3.5" />
        </FileSurfaceAction>
        <FileSurfaceAction
          label="Fit width"
          onPress={() => {
            setZoom(null);
            scroll.current?.scrollTo({ left: 0 });
          }}
        >
          <ScanIcon className="size-3.5" />
        </FileSurfaceAction>
        <div className="w-28">
          <Input
            ref={find}
            size="compact"
            type="search"
            aria-label="Find in PDF"
            placeholder="Find in PDF"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setMatches([]);
            }}
          />
        </div>
        {query ? (
          <>
            <span role="status">
              {finding ? "Searching…" : `${matches.length ? match + 1 : 0}/${matches.length}`}
            </span>
            <FileSurfaceAction
              label="Next matching page"
              disabled={!matches.length}
              onPress={() => {
                const next = (match + 1) % matches.length;
                setMatch(next);
                showPage(matches[next]!);
              }}
            >
              <ChevronDownIcon className="size-3.5" />
            </FileSurfaceAction>
          </>
        ) : null}
      </div>
      <div
        ref={scroll}
        role="region"
        aria-label={props.title}
        tabIndex={0}
        className="relative min-h-0 min-w-0 w-full flex-1 overflow-auto bg-muted/40"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "f") {
            event.preventDefault();
            event.stopPropagation();
            find.current?.focus();
          }
        }}
      >
        {error ? (
          <FileSurfaceFailure
            message={error}
            onRetry={() => {
              setError(null);
              setPdf(null);
              setRevision((value) => value + 1);
            }}
          />
        ) : !pdf ? (
          <FileSurfaceLoading />
        ) : (
          <div className="relative" style={{ height: offsets.at(-1), minWidth: width + 32 }}>
            {visible.map(({ index, ratio }) => (
              <div
                key={index}
                className="absolute bg-white shadow-sm"
                style={
                  {
                    top: offsets[index],
                    left: Math.max(16, (viewport.width - width) / 2),
                    width,
                    height: width * ratio,
                    "--total-scale-factor": 1,
                  } as CSSProperties
                }
              >
                <PdfPage
                  document={pdf}
                  index={index}
                  width={width}
                  query={query}
                  onSize={onSize}
                  onError={setError}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
