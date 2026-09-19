# Marginalia Pipeline

Turns public domain books into passage-plus-lesson records for the app.
Runs on your own machine — this half of the repo never ships.

## Prerequisites

- Node.js 18 or newer
- The `claude` CLI installed and logged in (run `claude` once, interactively,
  and log in — or set `ANTHROPIC_API_KEY` instead if you'd rather use that)
- Network access to gutenberg.org

## Setup

```
cd pipeline
npm install
```

(There are no npm dependencies right now — `annotate.js` calls the `claude`
CLI directly instead of the API SDK. `npm install` is just here for when
that changes.)

## Run order

1. `npm run fetch` — downloads the books listed in `books.json` into
   `data/raw/`. Skips books already downloaded, so it's safe to re-run.
2. `npm run clean` — strips the Gutenberg header/footer, splits into
   paragraphs, tracks chapter labels → `data/clean/`.
3. `npm run annotate -- --limit 20` — sends windows to Claude Sonnet 5 (via
   the CLI), one call per window, writing results to `data/candidates.json`
   as it goes. Start with `--limit 20` to see how the output looks and
   gauge the skip rate before spending on the whole book. Drop `--limit` to
   process everything once you're happy with it.
4. Open `review/index.html` directly in a browser — double-click the file,
   no server needed. Load `data/candidates.json` with the file picker, then
   review candidates one at a time:
   - `J` approve, `K` reject, `E` edit (lets you fix focus / note / vocab
     glosses inline — `Enter` saves and approves, `Esc` cancels without
     saving)
   - Arrow keys move between candidates
   - "Export approved.json" downloads only the approved records
5. Move the downloaded file to `pipeline/data/approved.json` (overwrite if
   one's already there).
6. `npm run validate` — checks `approved.json` against the record contract
   in `PLAN.md`. Exits non-zero on a real defect (bad offsets, duplicate
   ids, wrong lesson type, fewer than 3 books). Warns but still passes on
   soft issues, like a passage sitting a little outside its target
   word-count band.

## Phase 0 stop condition (from `PLAN.md`)

Don't start on `app/` until `pipeline/data/approved.json` has all of:

- **50 approved records**
- **all three lesson types** represented (`grammar`, `vocab`, `craft`)
- **at least 10 of type `craft`**
- records drawn from **3 or more books**
- `npm run validate` exits clean

`books.json` currently seeds just *Pride and Prejudice* — the plan calls
for measuring the skip rate on one book before scaling up. Once that looks
reasonable, add 2 or more further books to `books.json` (same
`{ "gutenbergId", "title", "author" }` shape) to reach the 3-book minimum.

## Re-running safely

- `fetch` and `clean` skip files that already exist.
- `annotate` caches every window's result by content hash in `data/.cache/`
  (gitignored) and skips any window whose id is already in
  `candidates.json` — an interrupted run won't re-bill windows it already
  finished.
- If you change the prompt in `src/annotate.js`, bump `PROMPT_VERSION` at
  the top of the file by hand, so old cached results from the previous
  prompt aren't silently reused under the new one.

## Cost note

Each `annotate.js` call goes through the `claude` CLI rather than the API,
so it rides your existing Claude Code login instead of a separate
`ANTHROPIC_API_KEY`. It still carries roughly 1,100 tokens of fixed CLI
overhead per window on top of the actual content — expect noticeably more
than a raw API call would cost for the same work. Use `--limit` liberally
while testing.
