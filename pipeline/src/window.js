// Groups a book's cleaned paragraphs into overlapping windows for
// annotate.js to analyze. A window is just an analysis unit — the LLM picks
// the actual passage from inside it. Windows are never written to disk; call
// buildWindows() from annotate.js, or run this file directly to sanity-check
// window counts for a book.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WINDOW_SIZE = 6;
const WINDOW_STRIDE = 4;

// Overlap (stride < size) means a teachable moment that falls near a window
// boundary still appears whole in a neighboring window.
export function buildWindows(bookId, paragraphs) {
  const windows = [];
  for (let start = 0; start < paragraphs.length; start += WINDOW_STRIDE) {
    const slice = paragraphs.slice(start, start + WINDOW_SIZE);
    if (slice.length === 0) break;
    windows.push({
      bookId,
      windowIndex: windows.length,
      chapter: slice[0].chapter,
      paragraphs: slice,
    });
    if (start + WINDOW_SIZE >= paragraphs.length) break;
  }
  return windows;
}

export function windowText(window) {
  return window.paragraphs.map((p) => p.text).join("\n\n");
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pipelineRoot = path.join(here, "..");
  const cleanDir = path.join(pipelineRoot, "data", "clean");
  const booksPath = path.join(pipelineRoot, "books.json");

  const books = JSON.parse(await fs.readFile(booksPath, "utf8"));
  for (const book of books) {
    const cleanPath = path.join(cleanDir, `${book.gutenbergId}.json`);
    const { paragraphs } = JSON.parse(await fs.readFile(cleanPath, "utf8"));
    const windows = buildWindows(book.gutenbergId, paragraphs);
    console.log(`${book.gutenbergId} (${book.title}) — ${windows.length} windows from ${paragraphs.length} paragraphs`);
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
