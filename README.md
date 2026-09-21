# Real Estate Document Search Engine

**Currently deployed on-premises for multiple real estate companies**, indexing
hundreds of thousands of files each — scanned land records, legal agreements,
floor plans, invoices, and site photos — and making them instantly searchable
in plain language.

---

## The problem

Real estate companies accumulate an enormous amount of paperwork over the
years: land records, legal agreements, surveyor documents, approval letters,
invoices, site photos. After a decade or two, this typically lives in a
deeply nested, inconsistent folder structure on a file server — the product
of many different people, over many years, with no consistent naming
convention.

Finding a specific document becomes a real operational problem:

- Staff know roughly *what* they're looking for ("the land agreement for
  that Bavdhan plot from around 2019") but have no way to search for it —
  only to browse folder by folder, hoping they remember where it was filed.
- A huge fraction of the archive is **scanned paper**, not searchable text —
  standard "Ctrl+F" style search tools are useless on a folder of images.
- The files themselves are often irreplaceable — nobody wants a tool that
  touches, reorganizes, or risks the original archive.
- These archives are too large (500GB–1TB+, hundreds of thousands of files)
  for a naive "throw it all into a cloud AI" approach to be affordable.

## The solution

This project builds a **searchable index on top of the existing archive**,
without ever touching the original files:

1. A crawler walks the messy source tree (read-only, always) and copies
   every file into one flat "pool" folder, recording where each one
   originally lived.
2. Each file is read once by an AI model — which understands scanned
   documents, typed text, spreadsheets, and photos alike — and produces a
   concise, human-readable summary plus a set of search keywords.
3. Only that summary and metadata (never the file's raw bytes) is stored in
   a search index.
4. Staff get a plain search bar: type a filename, a keyword, or a vague
   description, and get back the right file with one click to open it.

The original archive is never modified, moved, or deleted — the crawler
only ever reads from it and copies.

---

## How it works

```
┌──────────────┐     ┌──────────────┐     ┌───────────────────┐     ┌──────────────┐
│  Messy source │────▶│   Crawler    │────▶│   AI summarization │────▶│  Search index │
│  file server   │     │ (Python)     │     │  (Gemini / OpenRouter)│  │  (Firestore + │
│  (read-only)   │     │ flat pool +  │     │  summary + keywords │  │  Vertex Search)│
└──────────────┘     │ JSON mapping │     └───────────────────┘     └──────────────┘
                       └──────────────┘                                      │
                                                                              ▼
                                                                     ┌──────────────┐
                                                                     │  Search UI    │
                                                                     │  (Next.js)    │
                                                                     └──────────────┘
```

### 1. Crawler (Python)

Walks the source tree recursively and copies every file into a single flat
pool folder, recording the mapping (pool name → original path, size,
modified date) in a JSON file that's updated continuously as it works.

- **Never moves or deletes anything** — copy-only, source tree untouched.
- **Fully resumable** — if interrupted at any point (network drop, manual
  stop, crash), re-running picks up exactly where it left off with zero
  duplicated or lost work. Verified at 20,000+ file scale.
- **Handles genuinely messy real-world archives**: deeply nested paths
  beyond Windows' classic 260-character limit, filenames with characters
  that crash naive tools, name collisions across folders (two files both
  named `agreement.pdf` in different folders get deterministic,
  collision-safe names in the pool).
- **One-shot or continuous** — run it on demand to pick up new files, or
  point it at watch mode for continuous syncing.

### 2. AI summarization

Every pool file is read by an AI model and turned into a short, dense
summary plus a keyword list — the piece that makes search actually work on
unstructured content.

- **Every file type**: PDFs (scanned or digital), images and photos,
  Word/Excel/PowerPoint and their legacy formats, plain text — even images
  with no text at all get a real visual description, not just a filename
  guess.
- **Large documents don't get silently truncated.** Documents beyond a
  single AI request's practical size are automatically split into
  page-range chunks, summarized independently, and merged into one
  cohesive final summary — verified end-to-end on a 297-page real document,
  where a naive single-pass approach was found to silently drop 86% of the
  content from the summary.
- **Two interchangeable AI providers**, selected with one environment
  variable — call the model directly, or route through a cheaper
  third-party aggregator for the same model. Both paths share the same
  retry-with-backoff logic, per-request timeouts, and an absolute ceiling
  per file so a single bad document can never hang the whole pipeline.
- **A self-healing worker pool** renders PDF pages on dedicated background
  threads (not the main request thread) — a worker that hangs, crashes, or
  times out on a pathological file is automatically replaced, so processing
  hundreds of thousands of files unattended doesn't slowly lose capacity to
  one bad file.
- **Runs many files concurrently**, tuned and load-tested for real
  throughput rather than a single-file demo.

### 3. Search

Hybrid search across the generated index — name matching, keyword
matching, and semantic/content search — so a vague, natural-language query
still finds the right file even when the user doesn't remember its exact
name.

### 4. Web app (Next.js)

A simple internal search UI, plus two live monitoring pages for the
one-time indexing job: real-time progress, throughput, and a capped
recent-activity log (so watching a 450,000-file run doesn't mean scrolling
an infinite log). Both the crawl and the summarization stage can be
stopped and resumed at any time without losing or duplicating progress.

---

## Why this matters (the engineering problem, not just the pitch)

Building this well — not just as a demo, but as something that runs
unattended against a real, messy, decade-old archive — turned out to
involve a fair number of real problems that don't show up in a small test:

- **Cost at scale.** A naive "send every file to a large AI model" approach
  gets expensive fast across hundreds of thousands of files. Real testing
  against multiple AI providers and pricing tiers (not just published
  price cards, which turned out to be misleading — a cheaper-looking model
  tier tokenized the same document 2x less efficiently, actually costing
  *more*) led to a routing strategy with genuine, measured cost savings.
- **Reliability over days, not minutes.** A one-time indexing job against
  hundreds of thousands of files runs for days, unattended. Small test
  batches don't surface the failure modes that matter: a render thread
  that quietly hangs on one malformed PDF, a network blip with no retry,
  a request that never completes. All of these are handled explicitly,
  not assumed away.
- **Real files are messy.** Fifteen-plus years of unmanaged file storage
  means Unicode filename edge cases, path lengths that break naive tools,
  duplicate names across folders, and documents in formats nobody
  originally planned for. The crawler and pipeline are built around that
  reality, not a clean test dataset.

---

## Tech stack

| Layer | Technology |
|---|---|
| Crawler | Python 3.11+ |
| Web app | Next.js (App Router), TypeScript |
| AI summarization | Google Gemini (direct or via OpenRouter) |
| Search index | Google Cloud Firestore + Vertex AI Search |
| PDF rendering | pdfjs-dist + native canvas, on dedicated worker threads |
| Office file parsing | mammoth, xlsx, officeparser, word-extractor |

---

## Getting started

```bash
# Install dependencies
npm install

# Copy the example environment file and fill in real values
cp deploy/env.example .env.local

# Set up the crawler's Python environment
cd crawler
python -m venv venv
venv/Scripts/pip install -r requirements.txt
cd ..

# Run it
npm run dev
```

See `deploy/env.example` for every configuration option, including how to
switch between summarization providers.

### Deploying as a standalone service

`deploy/windows-install-services.ps1` registers the app as a Windows
service (via NSSM) that survives reboots and restarts on crash — the
crawler itself runs on-demand from the app's UI rather than as a separate
always-on service.

---

## Project structure

```
├── app/              # Next.js pages + API routes (search UI, crawl/sync monitoring)
├── lib/              # Core logic: crawling orchestration, AI summarization,
│                      # Firestore/Vertex Search integration, hybrid search
├── workers/           # Background worker threads (PDF page rendering)
├── crawler/           # Python crawler — flattens the source tree into a pool folder
└── deploy/             # Deployment scripts and configuration templates
```
