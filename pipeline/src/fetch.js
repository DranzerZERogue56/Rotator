// Downloads the raw text of every book listed in books.json from Project
// Gutenberg and saves it to data/raw/{id}.txt. Run with: npm run fetch

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineRoot = path.join(here, "..");
const booksPath = path.join(pipelineRoot, "books.json");
const rawDir = path.join(pipelineRoot, "data", "raw");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Gutenberg serves the same book under a couple of different file layouts
// depending on how old the posting is, so we try the modern URL first and
// fall back to the older one.
function urlsFor(id) {
  return [
    `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
  ];
}

async function downloadBook(id) {
  for (const url of urlsFor(id)) {
    const response = await fetch(url);
    if (response.ok) {
      return response.text();
    }
  }
  throw new Error(`No downloadable text found for Gutenberg ID ${id}`);
}

async function main() {
  const books = JSON.parse(await fs.readFile(booksPath, "utf8"));
  await fs.mkdir(rawDir, { recursive: true });

  for (const book of books) {
    const outPath = path.join(rawDir, `${book.gutenbergId}.txt`);

    // Already downloaded — don't hit Gutenberg again for a file we have.
    const alreadyExists = await fs
      .access(outPath)
      .then(() => true)
      .catch(() => false);
    if (alreadyExists) {
      console.log(`skip  ${book.gutenbergId} (${book.title}) — already downloaded`);
      continue;
    }

    console.log(`fetch ${book.gutenbergId} (${book.title})`);
    try {
      const text = await downloadBook(book.gutenbergId);
      await fs.writeFile(outPath, text, "utf8");
      console.log(`saved ${book.gutenbergId} (${text.length} chars)`);
    } catch (err) {
      console.error(`FAILED ${book.gutenbergId}: ${err.message}`);
    }

    // Be polite to Gutenberg's servers: one request at a time, with a gap.
    await sleep(1000);
  }
}

main();
