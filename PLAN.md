# Marginalia — Build Plan

*(Working name. Rename freely; it appears only in `app.json` and the header.)*

A mobile app that teaches grammar, vocabulary, and prose craft through short
passages from public domain books. The user scrolls a vertical feed. Each card
shows a passage plus one attached lesson.

This document is the authoritative spec. Work the phases in order. **Stop at each
phase boundary and wait for human review before starting the next phase.**

---

## 0. Ground rules for the agent

- Two separate codebases in one repo: `pipeline/` (Node, runs on a laptop, never
  ships) and `app/` (Expo, ships). They share only `app/assets/lessons.json`.
- Do not start `app/` until Phase 0's stop condition is met. The app is worthless
  without content, and the content format will change while the pipeline is built.
- No backend. No database. No user accounts. No network calls from the app.
  Everything the app needs is bundled at build time.
- Do not add a state management library. React state plus AsyncStorage is enough
  at this size.
- Do not write tests for the app UI in Phases 1 and 2. Do write the validator
  described in Phase 0.6, which is the only test that matters early.
- When a phase's stop condition is met, print a short summary and halt. Do not
  roll forward into the next phase.

---

## 1. Repository layout

```
marginalia/
  pipeline/
    books.json            # curated list of Gutenberg IDs + metadata
    src/
      fetch.js            # 0.1
      clean.js            # 0.2
      window.js           # 0.3
      annotate.js         # 0.4
      validate.js         # 0.6
    review/
      index.html          # 0.5, single file, no build step
    data/
      raw/                # downloaded .txt, gitignored
      clean/              # normalized paragraph arrays
      candidates.json     # LLM output, pre-review
      approved.json       # human-approved records
      .cache/             # annotation cache, gitignored
    package.json
  app/
    assets/lessons.json   # copied from approved.json
    src/
      screens/FeedScreen.js
      components/PassageCard.js
      components/LessonPanel.js
      components/FilterBar.js
      lib/storage.js
      lib/highlight.js
    App.js
    app.json
    package.json
  PLAN.md
```

---

## 2. Data model

One approved record:

```json
{
  "id": "austen-pp-0042",
  "source": {
    "title": "Pride and Prejudice",
    "author": "Jane Austen",
    "gutenbergId": 1342,
    "loc": "Chapter 3"
  },
  "text": "The passage itself, verbatim from the source.",
  "lesson": {
    "type": "grammar",
    "focus": "Semicolon joining two independent clauses",
    "note": "Two to four sentences explaining the rule as it operates here.",
    "highlights": [
      { "quote": "exact substring from text", "start": 104, "end": 137 }
    ]
  },
  "vocab": [
    {
      "word": "supercilious",
      "gloss": "Behaving as though one is superior to others.",
      "quote": "supercilious",
      "start": 88,
      "end": 100
    }
  ]
}
```

Field notes:

- `id` is `{authorSlug}-{titleInitials}-{4-digit counter}`. Stable across reruns.
- `lesson.type` is one of `grammar` | `vocab` | `craft`. Exactly one per record.
- `vocab` may be present on any type, but is required and non-empty when
  `type === "vocab"`.
- `highlights` may be empty for `craft` records where the lesson is about the
  whole passage rather than a specific span.

### Passage length is derived from lesson type, not fixed

| type      | target length      | rationale                                            |
|-----------|--------------------|------------------------------------------------------|
| `grammar` | 1 to 3 sentences   | The minimum span that demonstrates the construction. |
| `vocab`   | 40 to 150 words    | Enough surrounding context to infer meaning.         |
| `craft`   | 150 to 500 words   | Pacing and tension need room to be visible.          |

The annotation step chooses the span. Do **not** pre-chunk into fixed-size blocks
and then annotate. See 0.3 and 0.4.

### Offsets are computed, not generated

Language models are unreliable at character offsets. The LLM returns only `quote`
strings. `annotate.js` resolves `start` and `end` with `text.indexOf(quote)`.
If a quote is not found verbatim, or appears more than once, discard that
highlight and log it. Never fuzzy-match.

---

## Phase 0 — Content pipeline

Everything in `pipeline/`. Plain Node, ES modules, no TypeScript, no framework.

### 0.1 `fetch.js`

Read `books.json` (hand-curated, roughly this shape):

```json
[{ "gutenbergId": 1342, "title": "Pride and Prejudice", "author": "Jane Austen" }]
```

Download `https://www.gutenberg.org/files/{id}/{id}-0.txt`, falling back to
`https://www.gutenberg.org/cache/epub/{id}/pg{id}.txt`. Write to `data/raw/{id}.txt`.
Skip any file already present. Be polite: one request at a time, 1 second apart.

### 0.2 `clean.js`

For each raw file:

1. Strip everything before the `*** START OF TH{E,IS} PROJECT GUTENBERG EBOOK` line
   and everything after the matching `*** END OF` line. If either marker is absent,
   log the book and skip it rather than guessing.
2. Normalize line endings and collapse runs of spaces.
3. Split into paragraphs on blank lines. Join hard-wrapped lines within a paragraph
   into single lines.
4. Drop paragraphs under 40 characters (chapter headings, page furniture).
5. Track a running chapter label from lines matching `/^\s*(CHAPTER|Chapter)\s+[IVXLC0-9]/`
   so records can carry a `loc`.

Output `data/clean/{id}.json`: `{ meta, paragraphs: [{ index, chapter, text }] }`.

### 0.3 `window.js`

Build overlapping windows of 6 paragraphs with a stride of 4, so no teachable
moment is permanently split across a boundary. Emit
`{ bookId, windowIndex, chapter, paragraphs }`. Windows are analysis units only.
They are **not** passages. The passage is a span the LLM selects from within a window.

### 0.4 `annotate.js`

One LLM call per window. The model's job:

> Given this excerpt, find the single most teachable moment in it. Decide whether
> it best teaches a grammar rule, vocabulary, or a craft technique. Then return the
> minimal contiguous span of the excerpt that demonstrates it.

Requirements:

- The model returns `passage` as a verbatim contiguous substring of the window.
  Verify this with `includes()`. If it fails, retry once with the failure noted,
  then discard the window.
- Response must be JSON only, no prose, no code fences. Strip fences defensively
  before parsing anyway.
- The model may return `{ "skip": true, "reason": "..." }` for windows with nothing
  worth teaching. Expect this on a meaningful fraction of windows. That is correct
  behavior, not a bug. Do not tune the prompt to force a lesson out of every window.
- Cache by `sha256(windowText + promptVersion)` in `data/.cache/`. Reruns after a
  crash must not re-bill already-annotated windows. Bump `promptVersion` by hand
  when the prompt changes.
- Concurrency of 4, with retry and exponential backoff on rate limits.
- A `--limit N` flag for cheap test runs. Use it constantly during development.
- Append results to `data/candidates.json` incrementally, so an interrupted run
  keeps its work.

Start with the cheapest model available. Only escalate if `craft` lessons come back
shallow, which is the known weak spot.

### 0.5 `review/index.html`

A single self-contained HTML file. No build step, no npm packages, no CDN. Opened
directly with `file://`.

- Loads `candidates.json` via a file input (avoids `file://` fetch restrictions).
- Shows one candidate at a time: passage with highlights rendered, lesson type,
  focus, note, vocab list, and the source book.
- Keyboard driven: `J` approve, `K` reject, `E` edit, arrow keys to navigate.
  Editing is inline and covers `focus`, `note`, and vocab glosses. Approving after
  an edit saves the edited version.
- Persists decisions to `localStorage` continuously, so closing the tab loses nothing.
- An Export button downloads `approved.json` containing only approved records.
- Displays a running counter per lesson type, so the reviewer can see progress
  against the stop condition without counting by hand.

Manual step, not automated: copy the exported `approved.json` into
`pipeline/data/approved.json`.

### 0.6 `validate.js`

Runs against `approved.json` and exits non-zero on any failure:

- Every `id` unique and well-formed.
- `lesson.type` in the enum.
- Every `highlights[].quote` and `vocab[].quote` appears exactly once in `text`,
  and the stored `start`/`end` slice back to the quote.
- Word count within the band for the record's type (warn, do not fail, at the edges).
- `vocab` non-empty when `type === "vocab"`.
- At least one record from each of three or more distinct books.

### Phase 0 stop condition

`pipeline/data/approved.json` contains **50 approved records**, spanning all three
lesson types, with **at least 10 of type `craft`**, drawn from **3 or more books**,
and `validate.js` exits clean.

Stop here. The craft records are the quality signal for the whole project. Do not
proceed until a human has read them.

---

## Phase 1 — The feed

Expo app in `app/`. Managed workflow. `lessons.json` is a static import.

### Behavior

- Vertical paged feed. Use `FlatList` with `pagingEnabled`, `snapToInterval` set to
  the screen height, and `decelerationRate="fast"`.
- Each card renders the passage, a small source line (title, author, chapter), and
  a collapsed lesson strip at the bottom showing the type and `focus`.
- Tapping the strip expands it into the full `note` and vocab list.
- **Card layout constraint:** a 3-sentence grammar card and a 500-word craft card
  cannot share a fixed layout. The passage area is its own `ScrollView` inside the
  card. The swipe that advances the feed comes from a fixed footer zone, roughly
  the bottom 15 percent, so scrolling a long passage never fights the pager.
- Highlights: `lib/highlight.js` takes `text` plus a sorted span list and returns an
  array of `{ text, highlighted }` segments for rendering as nested `<Text>`. When
  the lesson panel is expanded, non-highlighted text dims to roughly 45 percent
  opacity and highlighted spans stay at full strength. This dimming effect is the
  core of the product. Get it right.
- `FilterBar` is a row of three toggles (grammar, vocab, craft), all on by default.
  Filtering is a client-side `Array.filter` on the imported JSON. When filters
  change, reset the feed to the top.

### Out of scope for Phase 1

No persistence, no saved items, no progress tracking, no animations beyond the
default pager physics, no onboarding, no settings screen.

### Phase 1 stop condition

On a physical device: all 50 records scroll smoothly, every lesson panel expands
and collapses, highlights render on the correct characters for every record, long
craft passages scroll internally without hijacking the pager, and each filter
toggle produces the correct subset.

Stop here.

---

## Phase 2 — Retention

- `lib/storage.js` wraps AsyncStorage with `getSaved()`, `saveItem()`,
  `removeItem()`, `getFilters()`, `setFilters()`. All reads go through an in-memory
  cache hydrated once at app start.
- A save control on each card. Saving a record stores its `id`. Saving a vocab word
  stores `{ recordId, word }`.
- A second screen listing saved words and saved records, grouped by book. Tapping an
  entry returns to that card in the feed.
- Filter state persists across launches. An app that dumps the user back into an
  unfiltered feed on every launch will not get used.

### Phase 2 stop condition

Saved items and filter state survive a full app restart, including a cold start
after the app is force-quit.

Stop here.

---

## Phase 3 — Recall

Deliberately unspecified. The right review mechanic depends on how Phases 1 and 2
actually get used. Do not design it in advance, and do not build scaffolding for it
during Phases 1 and 2.

---

## Known risks

- **Craft lesson quality.** The hardest thing for a model to do well and the most
  valuable thing in the app. If the 10 craft records from Phase 0 read like book
  report filler, the concept needs rethinking before any app code gets written.
- **Skip rate.** If the model skips more than roughly 70 percent of windows, the
  cost per approved record climbs fast. Measure it on the first book before
  scaling to more.
- **Highlight resolution failures.** Track how often `indexOf` fails or finds
  duplicates. A high rate means the prompt needs to demand longer, more distinctive
  quotes.
- **Copyright.** Public domain only. Do not add an in-copyright book to `books.json`
  under any circumstance, and do not add a user-upload path without a separate
  decision.
