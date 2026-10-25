export type DocumentThumbnailKind = "pdf" | "pptx" | "epub" | "csv";
export type DocumentThumbnail = { readonly blob: Blob; readonly label: string };
export const DOCUMENT_THUMBNAIL_MAX_BYTES = 20 * 1024 * 1024;

export function documentThumbnailKind(file: {
  name: string;
  mimeType?: string;
}): DocumentThumbnailKind | null {
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  if (extension === "pdf" || extension === "pptx" || extension === "epub" || extension === "csv")
    return extension;
  if (file.mimeType === "application/pdf") return "pdf";
  if (file.mimeType === "text/csv") return "csv";
  return null;
}
