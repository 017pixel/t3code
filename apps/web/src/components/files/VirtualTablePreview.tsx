/* oxlint-disable react/no-array-index-key -- Positions identify source rows and columns. */
import { LegendList } from "@legendapp/list/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { observeResize } from "~/lib/observeResize";
import { PREVIEW_PAGE_ROWS } from "./largeTextProtocol";

export default function VirtualTablePreview(props: {
  readonly name: string;
  readonly count: number;
  readonly columns: number;
  readonly getRows: (page: number) => readonly (readonly string[])[] | undefined;
  readonly loadPage?: (page: number) => void;
  readonly header?: readonly string[] | undefined;
  readonly source?: boolean;
  readonly wrap?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(0);
  const [width, setWidth] = useState(0);
  const measureRef = useRef<HTMLTableElement>(null);
  const [measured, setMeasured] = useState<number[] | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    return observeResize(node, () => {
      setWidth(node.clientWidth);
      setMeasured(null);
    });
  }, []);
  useLayoutEffect(() => {
    if (!width || !props.header || !measureRef.current || measured) return;
    const widths = [...measureRef.current.querySelectorAll("thead th")].map(
      (cell) => cell.getBoundingClientRect().width,
    );
    if (widths.length) setMeasured(widths);
  }, [measured, width, props.header]);
  const pages = Array.from(
    { length: Math.ceil(props.count / PREVIEW_PAGE_ROWS) },
    (_, index) => index,
  );
  const columnWidth = props.source
    ? 0
    : Math.max(96, Math.min(320, width / Math.min(props.columns, 6)));
  const rowHeader = props.header ? 0 : 56;
  const firstColumn = props.source
    ? 0
    : Math.max(0, Math.floor((left - rowHeader) / columnWidth) - 1);
  const lastColumn = props.source
    ? 1
    : Math.min(props.columns, Math.ceil((left + width) / columnWidth) + 1);
  const columns = Array.from(
    { length: Math.max(0, lastColumn - firstColumn) },
    (_, i) => firstColumn + i,
  );
  const sizes = Array.from(
    { length: props.columns },
    (_, column) => measured?.[column] ?? columnWidth,
  );
  const offset = (column: number) =>
    sizes.slice(0, column).reduce((total, size) => total + size, 0);
  const tableWidth = props.source ? "100%" : Math.max(width, offset(props.columns) + rowHeader);
  return (
    <div
      ref={ref}
      className="relative min-h-0 flex-1 overflow-x-auto"
      onScroll={(event) => {
        setLeft(event.currentTarget.scrollLeft);
        setWidth(event.currentTarget.clientWidth);
      }}
    >
      {props.header && props.columns <= 30 && !measured && width > 0 ? (
        <table
          ref={measureRef}
          aria-hidden="true"
          className="invisible absolute top-0 border-separate border-spacing-0 text-xs"
          style={{ width }}
        >
          <thead>
            <tr>
              {props.header.map((cell, i) => (
                <th
                  key={i}
                  className="max-w-80 border-b px-3 py-1.5 text-left font-medium whitespace-pre-wrap break-words"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props
              .getRows(0)
              ?.slice(1, 20)
              .map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className="max-w-80 border-b px-3 py-1.5 whitespace-pre-wrap break-words tabular-nums"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      ) : null}
      <div
        role={props.source ? "region" : "table"}
        aria-label={props.name}
        aria-rowcount={props.count}
        aria-colcount={props.source ? undefined : props.columns}
        className="flex h-full min-h-0 flex-col text-xs"
        style={{ width: tableWidth }}
      >
        {!props.source ? (
          <div
            role="row"
            className="relative z-10 flex min-h-[29px] shrink-0 border-b border-border bg-muted/60 font-medium backdrop-blur"
          >
            {!props.header ? (
              <div className="sticky left-0 z-10 shrink-0 bg-muted" style={{ width: rowHeader }} />
            ) : null}
            <div style={{ width: offset(firstColumn), flexShrink: 0 }} />
            {columns.map((column) => (
              <div
                key={column}
                role="columnheader"
                aria-colindex={column + 1}
                className="shrink-0 overflow-hidden px-3 py-1.5 whitespace-pre"
                style={{ width: sizes[column] }}
              >
                {props.header?.[column] ?? columnLabel(column)}
              </div>
            ))}
          </div>
        ) : null}
        {props.count > 500_000 ? (
          <ScaledRows
            {...props}
            columnsVisible={columns}
            sizes={sizes}
            rowHeader={rowHeader}
            firstColumn={firstColumn}
          />
        ) : (
          <LegendList
            data={pages}
            keyExtractor={String}
            estimatedItemSize={PREVIEW_PAGE_ROWS * 29}
            drawDistance={100}
            style={{ flex: 1, minHeight: 0 }}
            extraData={[props.getRows, firstColumn, lastColumn, props.wrap]}
            renderItem={({ item: page }) => (
              <RowPage
                page={page}
                {...props}
                columnsVisible={columns}
                sizes={sizes}
                rowHeader={rowHeader}
                firstColumn={firstColumn}
              />
            )}
          />
        )}
      </div>
    </div>
  );
}
function RowPage(
  props: Parameters<typeof VirtualTablePreview>[0] & {
    page: number;
    columnsVisible: number[];
    sizes: number[];
    rowHeader: number;
    firstColumn: number;
  },
) {
  const rows = props.getRows(props.page);
  // A page stays mounted while the worker fills it, preserving the scroll position.
  const { loadPage, page } = props;
  useEffect(() => {
    if (!rows) loadPage?.(page);
  }, [rows, page, loadPage]);
  const start = props.page * PREVIEW_PAGE_ROWS;
  const count = Math.min(PREVIEW_PAGE_ROWS, props.count - start);
  return (
    <div role="rowgroup">
      {Array.from({ length: count }, (_, local) => {
        const row = rows?.[local];
        const index = start + local;
        if (props.header && index === 0) return null;
        return (
          <div
            key={local}
            role={props.source ? undefined : "row"}
            aria-rowindex={props.source ? undefined : index + 1}
            className={
              props.source
                ? "flex min-h-[29px] font-mono"
                : `flex min-h-[29px] border-b border-border/60 ${(index - (props.header ? 1 : 0)) % 2 ? "bg-muted/30" : ""}`
            }
          >
            {!props.header ? (
              <div
                role={props.source ? undefined : "rowheader"}
                className="sticky left-0 z-1 shrink-0 bg-muted px-2 py-1.5 text-right font-normal text-muted-foreground tabular-nums select-none"
                style={{ width: props.rowHeader }}
              >
                {index + 1}
              </div>
            ) : null}
            {!props.source ? (
              <div
                style={{
                  width: props.sizes.slice(0, props.firstColumn).reduce((a, b) => a + b, 0),
                  flexShrink: 0,
                }}
              />
            ) : null}
            {props.columnsVisible.map((column) => (
              <div
                key={column}
                role={props.source ? undefined : "cell"}
                aria-colindex={props.source ? undefined : column + 1}
                className={
                  props.source
                    ? `min-w-0 flex-1 px-3 py-1 ${props.wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"}`
                    : "shrink-0 px-3 py-1.5 whitespace-pre-wrap break-words tabular-nums"
                }
                style={props.source ? undefined : { width: props.sizes[column] }}
              >
                {row?.[column] ?? ""}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ScaledRows(props: Omit<Parameters<typeof RowPage>[0], "page">) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState({ offset: 0, height: 0 });
  const [position, setPosition] = useState({ top: 0, height: 600 });
  const scrollHeight = 8_000_000;
  // Chromium caps a scroll surface at 33 million pixels. Scale the track for
  // multi-million-line logs while retaining real row heights in the viewport.
  const maxFirst = Math.max(0, props.count - Math.floor(position.height / 29));
  const scale = Math.max(1, scrollHeight - position.height) / Math.max(1, maxFirst * 29);
  const first = Math.min(maxFirst, Math.floor(position.top / scale / 29));
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setPosition({ top: node.scrollTop, height: node.clientHeight });
    const stop = observeResize(node, update);
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 29 : event.deltaMode === 2 ? node.clientHeight : 1);
      if (!delta) return;
      event.preventDefault();
      node.scrollTop += delta * scale;
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => {
      stop();
      node.removeEventListener("wheel", wheel);
    };
  }, [scale]);
  const page = Math.floor(first / PREVIEW_PAGE_ROWS);
  useLayoutEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const update = () => {
      const rows = node.querySelectorAll<HTMLElement>("[role=rowgroup] > div");
      const row = rows[first % PREVIEW_PAGE_ROWS];
      const offset = row ? row.getBoundingClientRect().top - node.getBoundingClientRect().top : 0;
      const height = node.clientHeight;
      setLayout((old) =>
        old.offset === offset && old.height === height ? old : { offset, height },
      );
    };
    update();
    return observeResize(node, update);
  }, [first]);
  return (
    <div
      ref={ref}
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto"
      onKeyDown={(event) => {
        const node = event.currentTarget;
        const delta =
          event.key === "ArrowDown"
            ? 29
            : event.key === "ArrowUp"
              ? -29
              : event.key === "PageDown"
                ? node.clientHeight
                : event.key === "PageUp"
                  ? -node.clientHeight
                  : null;
        if (delta !== null) {
          event.preventDefault();
          node.scrollTop += delta * scale;
        } else if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          node.scrollTop = event.key === "Home" ? 0 : scrollHeight;
        }
      }}
      onScroll={(event) =>
        setPosition({
          top: event.currentTarget.scrollTop,
          height: event.currentTarget.clientHeight,
        })
      }
    >
      <div className="relative" style={{ height: scrollHeight }}>
        <div
          ref={contentRef}
          className="absolute inset-x-0"
          style={{
            top:
              position.top +
              (position.top >= scrollHeight - position.height - 1
                ? position.height - layout.height
                : -layout.offset),
          }}
        >
          <RowPage {...props} page={page} />
          {page + 1 < Math.ceil(props.count / PREVIEW_PAGE_ROWS) ? (
            <RowPage {...props} page={page + 1} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function columnLabel(index: number): string {
  let label = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  return label;
}
