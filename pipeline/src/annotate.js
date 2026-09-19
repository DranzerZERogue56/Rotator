// Sends each analysis window to Claude — via a headless `claude -p` CLI
// call, using whatever Claude Code login/subscription is already on this
// machine instead of a separate ANTHROPIC_API_KEY — asking it to find the
// single most teachable moment and return a verbatim passage plus a lesson.
// Results are written incrementally to data/candidates.json for human
// review in review/index.html. Run with: npm run annotate -- --limit 20
//
// Requires the `claude` CLI installed and logged in (run `claude` once
// interactively to log in, or set ANTHROPIC_API_KEY) on whatever machine
// runs this script.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { buildWindows, windowText } from "./window.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pipelineRoot = path.join(here, "..");
const booksPath = path.join(pipelineRoot, "books.json");
const cleanDir = path.join(pipelineRoot, "data", "clean");
const cacheDir = path.join(pipelineRoot, "data", ".cache");
const candidatesPath = path.join(pipelineRoot, "data", "candidates.json");

// Bump this by hand whenever PROMPT below changes, so cached results from
// the old prompt aren't reused as if they came from the new one.
const PROMPT_VERSION = 1;
const MODEL = "claude-sonnet-5";
const CLAUDE_BIN = "claude";
const CONCURRENCY = 4;
const MAX_RETRIES = 5;
// HTTP statuses worth retrying: rate limited, overloaded, or a transient
// server-side failure. Anything else (bad request, auth, unknown model) is
// not going to fix itself on retry.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

const LESSON_TYPES = new Set(["grammar", "vocab", "craft"]);
const TITLE_STOPWORDS = new Set(["a", "an", "the", "of", "and", "in", "on", "for", "to", "or"]);

const PROMPT = `Given this excerpt from a novel, find the single most teachable moment in it. Decide whether it best teaches a grammar rule, vocabulary, or a craft technique. Then return the minimal contiguous span of the excerpt that demonstrates it.

Target passage length by type:
- grammar: 1 to 3 sentences (the minimum span that demonstrates the construction)
- vocab: 40 to 150 words (enough surrounding context to infer meaning)
- craft: 150 to 500 words (pacing and tension need room to be visible)

If nothing in this excerpt is worth teaching, respond with {"skip": true, "reason": "..."}.

Otherwise respond with ONLY this JSON shape, no prose, no code fences:
{
  "passage": "verbatim contiguous substring of the excerpt",
  "type": "grammar" | "vocab" | "craft",
  "focus": "short label for what this teaches",
  "note": "two to four sentences explaining the rule/word/technique as it operates here",
  "highlights": [{ "quote": "exact substring of passage" }],
  "vocab": [{ "word": "...", "gloss": "...", "quote": "exact substring of passage" }]
}

"highlights" may be an empty array for craft lessons about the whole passage rather than a specific span. "vocab" is required and non-empty only when type is "vocab"; omit it or leave it empty otherwise.`;

function stripFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1] : trimmed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tiny concurrency limiter — no dependency needed for something this small.
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

function authorSlug(author) {
  const lastName = author.trim().split(/\s+/).pop();
  return lastName.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function titleInitials(title) {
  return title
    .split(/\s+/)
    .filter((word) => !TITLE_STOPWORDS.has(word.toLowerCase()))
    .map((word) => word[0].toLowerCase())
    .join("");
}

function windowId(book, window) {
  return `${authorSlug(book.author)}-${titleInitials(book.title)}-${String(window.windowIndex).padStart(4, "0")}`;
}

function hashWindow(text) {
  return crypto.createHash("sha256").update(`${PROMPT_VERSION}\n${text}`).digest("hex");
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

async function loadCache(hash) {
  return readJsonIfExists(path.join(cacheDir, `${hash}.json`), null);
}

async function saveCache(hash, result) {
  await fs.writeFile(path.join(cacheDir, `${hash}.json`), JSON.stringify(result, null, 2), "utf8");
}

// All appends go through this queue so concurrent windows can't race each
// other reading and rewriting the same candidates.json.
let writeQueue = Promise.resolve();
function appendCandidate(record) {
  writeQueue = writeQueue.then(async () => {
    const existing = await readJsonIfExists(candidatesPath, []);
    existing.push(record);
    await fs.writeFile(candidatesPath, JSON.stringify(existing, null, 2), "utf8");
  });
  return writeQueue;
}

// Thrown when the claude CLI itself reports an API-level failure
// (envelope.is_error), carrying the HTTP status so the retry loop can tell
// "rate limited, try again" apart from "this will never succeed".
class ClaudeCliError extends Error {
  constructor(message, apiErrorStatus) {
    super(message);
    this.apiErrorStatus = apiErrorStatus;
  }
}

// Runs one window through `claude -p`, piping the excerpt in on stdin so we
// never have to shell-escape book text. --tools "" and --setting-sources ""
// keep this a plain text-in/JSON-out call instead of a full agent session:
// no file/bash access, and no CLAUDE.md or project settings bleeding into
// the annotation prompt.
function callModel(excerptText) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, [
      "-p",
      "--output-format", "json",
      "--model", MODEL,
      "--tools", "",
      "--setting-sources", "",
      "--system-prompt", PROMPT,
    ]);

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      reject(new Error(`could not run "${CLAUDE_BIN}" — is Claude Code installed and on PATH? (${err.message})`));
    });
    child.on("close", () => {
      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        reject(new Error(`claude CLI produced non-JSON output: ${(stderr || stdout).slice(0, 300)}`));
        return;
      }
      if (envelope.is_error) {
        reject(new ClaudeCliError(envelope.result || "claude CLI reported an error", envelope.api_error_status));
        return;
      }
      resolve(envelope.result ?? "");
    });

    child.stdin.write(excerptText);
    child.stdin.end();
  });
}

async function callModelWithRetry(excerptText) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callModel(excerptText);
    } catch (err) {
      const retryable = err instanceof ClaudeCliError && RETRYABLE_STATUSES.has(err.apiErrorStatus);
      if (retryable && attempt < MAX_RETRIES) {
        const backoffMs = 1000 * 2 ** attempt;
        console.warn(`claude CLI call failed (status ${err.apiErrorStatus}), retrying in ${backoffMs}ms`);
        await sleep(backoffMs);
        continue;
      }
      throw err;
    }
  }
}

// The model returns quotes, never offsets — models are unreliable at
// character positions. We find the offset ourselves and refuse to guess: a
// quote that isn't found verbatim, or that matches more than once, is
// dropped and logged rather than fuzzy-matched.
function resolveQuote(passage, quote, label) {
  const firstIndex = passage.indexOf(quote);
  if (firstIndex === -1) {
    console.warn(`  discard ${label}: quote not found verbatim`);
    return null;
  }
  if (passage.indexOf(quote, firstIndex + 1) !== -1) {
    console.warn(`  discard ${label}: quote appears more than once`);
    return null;
  }
  return { start: firstIndex, end: firstIndex + quote.length };
}

async function annotateWindow(book, window) {
  const excerptText = windowText(window);
  const hash = hashWindow(excerptText);

  let result = await loadCache(hash);
  if (result === null) {
    let raw = await callModelWithRetry(excerptText);
    let parsed = tryParse(raw);

    if (parsed && parsed.skip !== true && !isVerbatimPassage(excerptText, parsed)) {
      console.warn(`  retry ${book.gutenbergId}#${window.windowIndex}: passage not verbatim`);
      raw = await callModelWithRetry(excerptText);
      parsed = tryParse(raw);
    }

    if (!parsed || (parsed.skip !== true && !isVerbatimPassage(excerptText, parsed))) {
      parsed = { skip: true, reason: "passage failed verbatim check twice, or response was not valid JSON" };
    }

    result = parsed;
    await saveCache(hash, result);
  }

  if (result.skip) {
    console.log(`skip  ${book.gutenbergId}#${window.windowIndex}: ${result.reason ?? "no reason given"}`);
    return;
  }

  if (!LESSON_TYPES.has(result.type)) {
    console.warn(`discard ${book.gutenbergId}#${window.windowIndex}: unknown lesson type "${result.type}"`);
    return;
  }

  const label = `${book.gutenbergId}#${window.windowIndex}`;
  const highlights = (result.highlights ?? [])
    .map((h) => {
      const span = resolveQuote(result.passage, h.quote, `${label} highlight`);
      return span && { quote: h.quote, ...span };
    })
    .filter(Boolean);

  const vocab = (result.vocab ?? [])
    .map((v) => {
      const span = resolveQuote(result.passage, v.quote, `${label} vocab`);
      return span && { word: v.word, gloss: v.gloss, quote: v.quote, ...span };
    })
    .filter(Boolean);

  const record = {
    id: windowId(book, window),
    source: {
      title: book.title,
      author: book.author,
      gutenbergId: book.gutenbergId,
      loc: window.chapter ?? null,
    },
    text: result.passage,
    lesson: {
      type: result.type,
      focus: result.focus,
      note: result.note,
      highlights,
    },
    vocab,
  };

  await appendCandidate(record);
  console.log(`saved ${label} (${result.type}): ${result.focus}`);
}

function isVerbatimPassage(excerptText, parsed) {
  return typeof parsed.passage === "string" && parsed.passage.length > 0 && excerptText.includes(parsed.passage);
}

function tryParse(text) {
  try {
    return JSON.parse(stripFences(text));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const limitFlagIndex = argv.indexOf("--limit");
  const limit = limitFlagIndex === -1 ? Infinity : Number(argv[limitFlagIndex + 1]);
  return { limit };
}

function checkClaudeCliAvailable() {
  const check = spawnSync(CLAUDE_BIN, ["--version"]);
  if (check.error || check.status !== 0) {
    console.error(`"${CLAUDE_BIN}" CLI not found or not working. Install Claude Code and run "claude" once to log in, then try again.`);
    process.exit(1);
  }
}

async function main() {
  checkClaudeCliAvailable();
  const { limit } = parseArgs(process.argv.slice(2));
  const books = JSON.parse(await fs.readFile(booksPath, "utf8"));
  const existingCandidates = await readJsonIfExists(candidatesPath, []);
  const existingIds = new Set(existingCandidates.map((c) => c.id));

  await fs.mkdir(cacheDir, { recursive: true });
  const limiter = createLimiter(CONCURRENCY);

  let processed = 0;
  const tasks = [];

  for (const book of books) {
    const cleanPath = path.join(cleanDir, `${book.gutenbergId}.json`);
    const { paragraphs } = JSON.parse(await fs.readFile(cleanPath, "utf8"));
    const windows = buildWindows(book.gutenbergId, paragraphs);

    for (const window of windows) {
      if (existingIds.has(windowId(book, window))) continue;
      if (processed >= limit) break;
      processed += 1;
      tasks.push(limiter(() => annotateWindow(book, window)));
    }
  }

  await Promise.all(tasks);
  console.log(`done — processed ${tasks.length} windows`);
}

main();
