// Checks pipeline/data/approved.json against the record contract described
// in PLAN.md. Exits non-zero if anything is actually broken. Run with:
// npm run validate

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const approvedPath = path.join(here, "..", "data", "approved.json");

const LESSON_TYPES = new Set(["grammar", "vocab", "craft"]);
const ID_PATTERN = /^[a-z0-9]+-[a-z0-9]+-\d{4}$/;
const WORD_COUNT_BANDS = { vocab: [40, 150], craft: [150, 500] };
const GRAMMAR_SENTENCE_BAND = [1, 3];

const failures = [];
const warnings = [];

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function sentenceCount(text) {
  return text.split(/[.!?]+(\s|$)/).map((s) => s.trim()).filter(Boolean).length;
}

function countOccurrences(haystack, needle) {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + 1;
  }
  return count;
}

function checkQuoteSpan(record, span, label) {
  const occurrences = countOccurrences(record.text, span.quote);
  if (occurrences !== 1) {
    failures.push(`${record.id}: ${label} quote "${span.quote}" appears ${occurrences} times in text (must be exactly 1)`);
    return;
  }
  const slice = record.text.slice(span.start, span.end);
  if (slice !== span.quote) {
    failures.push(`${record.id}: ${label} start/end (${span.start}, ${span.end}) does not slice back to its quote`);
  }
}

function checkRecord(record) {
  if (!ID_PATTERN.test(record.id)) {
    failures.push(`${record.id}: id is not well-formed (expected {slug}-{initials}-{4 digits})`);
  }

  if (!LESSON_TYPES.has(record.lesson?.type)) {
    failures.push(`${record.id}: lesson.type "${record.lesson?.type}" is not one of grammar | vocab | craft`);
    return; // nothing further to check without a valid type
  }

  for (const h of record.lesson.highlights ?? []) {
    checkQuoteSpan(record, h, "highlight");
  }
  for (const v of record.vocab ?? []) {
    checkQuoteSpan(record, v, "vocab");
  }

  if (record.lesson.type === "vocab" && (record.vocab ?? []).length === 0) {
    failures.push(`${record.id}: type is "vocab" but vocab[] is empty`);
  }

  if (record.lesson.type === "grammar") {
    const [min, max] = GRAMMAR_SENTENCE_BAND;
    const count = sentenceCount(record.text);
    if (count < min || count > max) {
      warnings.push(`${record.id}: grammar passage has ${count} sentences (target ${min}-${max})`);
    }
  } else {
    const [min, max] = WORD_COUNT_BANDS[record.lesson.type];
    const count = wordCount(record.text);
    if (count < min || count > max) {
      warnings.push(`${record.id}: ${record.lesson.type} passage has ${count} words (target ${min}-${max})`);
    }
  }
}

async function main() {
  const approved = JSON.parse(await fs.readFile(approvedPath, "utf8"));

  const seenIds = new Set();
  for (const record of approved) {
    if (seenIds.has(record.id)) {
      failures.push(`duplicate id: ${record.id}`);
    }
    seenIds.add(record.id);
    checkRecord(record);
  }

  const distinctBooks = new Set(approved.map((r) => r.source?.gutenbergId));
  if (distinctBooks.size < 3) {
    failures.push(`only ${distinctBooks.size} distinct book(s) represented; need at least 3`);
  }

  for (const warning of warnings) {
    console.warn(`warn  ${warning}`);
  }
  for (const failure of failures) {
    console.error(`FAIL  ${failure}`);
  }

  console.log(`${approved.length} records, ${failures.length} failure(s), ${warnings.length} warning(s)`);
  process.exit(failures.length > 0 ? 1 : 0);
}

main();
