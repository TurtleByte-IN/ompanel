import { beginForegroundHandoff } from "./foreground-handoff";

const HTML_EXPORT_DIRECTORY = "html-exports";

/** A file name safe to write: path separators and control characters become dashes. */
function safeFileName(fileName: string): string {
  const cleaned = fileName.replace(/[/\\:\u0000-\u001f]/g, "-").trim();
  return cleaned === "" ? "export.html" : cleaned;
}

/**
 * Writes `html` to a cache file named `fileName` and opens the system share sheet for it, so
 * the user can save it to Files, AirDrop it or open it in a browser.
 */
export async function shareHtmlFile(fileName: string, html: string): Promise<void> {
  const [{ Directory, File, Paths }, Sharing] = await Promise.all([
    import("expo-file-system"),
    import("expo-sharing"),
  ]);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Saving and sharing files is unavailable on this device.");
  }
  const directory = new Directory(Paths.cache, HTML_EXPORT_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, safeFileName(fileName));
  file.create({ overwrite: true });
  await file.write(html);
  const endHandoff = beginForegroundHandoff();
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: "text/html",
      UTI: "public.html",
      dialogTitle: fileName,
    });
  } finally {
    endHandoff();
  }
}
