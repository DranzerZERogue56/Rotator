// Turns each raw Gutenberg .txt file into a normalized array of paragraphs
// with chapter labels attached. Run with: npm run clean

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineRoot = path.join(here, "..");
const booksPath = path.join(pipelineRoot, "books.json");
const rawDir = path.join(pipelineRoot, "data", "raw");
const cleanDir = path.join(pipelineRoot, "data", "clean");

const START_MARKER = /\*\*\*\s*START OF TH[EI]S? PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i;
const END_MARKER = /\*\*\*\s*END OF[^*]*\*\*\*/i;
const CHAPTER_LINE = /^\s*(CHAPTER|Chapter)\s+[IVXLC0-9]/;
const MIN_PARAGRAPH_LENGTH = 40;

// Cuts everything outside the Gutenberg header/footer. If either marker is
// missing we can't be sure where the real book starts or ends, so the book
// is skipped rather than guessed at.
function stripBoilerplate(rawText) {
  const startMatch = rawText.match(START_MARKER);
  const endMatch = rawText.match(END_MARKER);
  if (!startMatch || !endMatch) {
    return null;
  }
  const bodyStart = startMatch.index + startMatch[0].length;
  const bodyEnd = endMatch.index;
  if (bodyEnd <= bodyStart) {
    return null;
  }
  return rawText.slice(bodyStart, bodyEnd);
}

function normalizeWhitespace(text) {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");
}

// Gutenberg text is hard-wrapped at a fixed column. A "paragraph" on disk is
// a run of lines with no blank line between them; we join those lines back
// into one continuous line of prose.
function splitParagraphs(bodyText) {
  return bodyText
    .split(/\n\s*\n/)
    .map((block) =>
      block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ")
        .trim(),
    )
    .filter(Boolean);
}

function buildParagraphRecords(rawParagraphs) {
  const records = [];
  let currentChapter = null;
  let index = 0;

  for (const paragraph of rawParagraphs) {
    if (CHAPTER_LINE.test(paragraph)) {
      currentChapter = paragraph;
    }
    if (paragraph.length < MIN_PARAGRAPH_LENGTH) {
      continue; // chapter headings and other page furniture
    }
    records.push({ index, chapter: currentChapter, text: paragraph });
    index += 1;
  }

  return records;
}

async function cleanBook(book) {
  const rawPath = path.join(rawDir, `${book.gutenbergId}.txt`);
  const rawText = await fs.readFile(rawPath, "utf8");

  const body = stripBoilerplate(normalizeWhitespace(rawText));
  if (body === null) {
    console.error(`skip  ${book.gutenbergId} (${book.title}) — start/end marker not found`);
    return;
  }

  const paragraphs = buildParagraphRecords(splitParagraphs(body));
  const outPath = path.join(cleanDir, `${book.gutenbergId}.json`);
  await fs.writeFile(
    outPath,
    JSON.stringify({ meta: book, paragraphs }, null, 2),
    "utf8",
  );
  console.log(`clean ${book.gutenbergId} (${book.title}) — ${paragraphs.length} paragraphs`);
}

async function main() {
  const books = JSON.parse(await fs.readFile(booksPath, "utf8"));
  await fs.mkdir(cleanDir, { recursive: true });

  for (const book of books) {
    await cleanBook(book);
  }
}

main();
