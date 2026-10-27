// @effect-diagnostics nodeBuiltinImport:off - Reads Markdown files on disk.
//
// Validates relative links in README.md and docs/**/*.md: the target file or directory must
// exist, and a `#fragment` pointing at a Markdown file must match one of its headings (GitHub
// slug rules). External links (scheme or `//`) are not checked. Exits 1 on any broken link.

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function markdownFiles(dir: string): string[] {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

/** Drops fenced code blocks and inline code spans, keeping line count. */
function stripCode(text: string): string {
  let fenced = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return "";
      }
      return fenced ? "" : line.replace(/`[^`]*`/g, "");
    })
    .join("\n");
}

/** GitHub heading anchor: lowercase, drop punctuation except `-` and `_`, spaces to `-`. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

const anchorCache = new Map<string, Set<string>>();

/** Heading anchors of a Markdown file (plus explicit `<a name|id>`), outside code fences. */
function anchors(file: string): Set<string> {
  const cached = anchorCache.get(file);
  if (cached) return cached;
  const result = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of NodeFS.readFileSync(file, "utf8").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    for (const match of line.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) result.add(match[1]!);
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = slug(heading[1]!.replace(/`/g, ""));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  anchorCache.set(file, result);
  return result;
}

const LINK =
  /!?\[(?:[^\][]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm;

export function checkFile(file: string): string[] {
  const errors: string[] = [];
  const lines = stripCode(NodeFS.readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, index) => {
    for (const match of line.matchAll(LINK)) {
      const target = match[1] ?? match[2]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      const [rawPath, fragment] = target.split("#", 2) as [string, string | undefined];
      const path = decodeURIComponent(rawPath.split("?")[0]!);
      const resolved = path === "" ? file : NodePath.resolve(NodePath.dirname(file), path);
      const where = `${NodePath.relative(ROOT, file)}:${index + 1}`;
      if (!NodeFS.existsSync(resolved)) {
        errors.push(`${where}: missing ${target}`);
        continue;
      }
      if (fragment && resolved.endsWith(".md") && !anchors(resolved).has(fragment)) {
        errors.push(`${where}: no heading #${fragment} in ${NodePath.relative(ROOT, resolved)}`);
      }
    }
  });
  return errors;
}

if (import.meta.main) {
  const files = [NodePath.join(ROOT, "README.md"), ...markdownFiles(NodePath.join(ROOT, "docs"))];
  const errors = files.flatMap(checkFile);
  for (const error of errors) console.error(error);
  console.log(`check-doc-links: ${files.length} files, ${errors.length} broken links`);
  process.exitCode = errors.length > 0 ? 1 : 0;
}
