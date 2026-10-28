# Architecture

How the Ora binary is built and why each choice was made.

- [One binary](#one-binary)
- [PDFs become images](#pdfs-become-images)
- [Rendering runs in a child process](#rendering-runs-in-a-child-process)
- [SQLite through FFI](#sqlite-through-ffi)
- [Voice turns](#voice-turns)
- [Context](#context)
- [The web UI](#the-web-ui)
- [The orb and the persona](#the-orb-and-the-persona)
- [Invariants](#invariants)
- [Out of scope](#out-of-scope)

## One binary

The server is TypeScript compiled to a native program with [scriptc](https://github.com/vercel-labs/scriptc),
using Node's `node:*` APIs. The web bundle is generated into `src/server/assets.gen.ts` and compiled in, so the
only external pieces at run time are `llama-server`, a model and the config. SQLite and PDFium are called through
scriptc's FFI. `scriptc` 0.4.5 supports a subset of TypeScript and has no cross-compile flag, so each platform is
built on that platform.

## PDFs become images

A PDF is rendered to one JPEG per page and sent to the model as images, never converted to text, so figures
and layout survive. The page size is 1024, 1536 or 2048 px on the longest side (capped at 4096) and at most 200
pages are rendered. PDFium is used through `ffi/orapdf.c`, which reads pixels as BGRx (`FPDFBitmap_BGRx = 3`;
the value 2 is 3-byte BGR and garbles the page), converts them to RGB and encodes JPEG with the vendored
`stb_image_write`.

## Rendering runs in a child process

A malformed PDF can crash PDFium. The server runs `ora --render-pdf <in> <outDir> <px> <maxPages>` as a child
of the same binary, with a 120 s timeout. The child writes `0000.jpg`, `0001.jpg` and so on, or `error.txt`, and
exits 0 or 2. A crash costs one upload, not the server.

The PDFium library is embedded in the binary. On Linux it loads from an anonymous in-memory file, on macOS from a
temp file deleted right after loading, and on Windows from `%TEMP%\ora-pdfium-<size>.dll`, written once and
reused because Windows cannot delete a loaded DLL. Third-party details are in
[../THIRD_PARTY.md](../THIRD_PARTY.md).

## SQLite through FFI

SQLite 3.54.1 is vendored and compiled in with FTS5. Documents are split into chunks and indexed with the
`porter unicode61` tokenizer, and search results are ranked with bm25. Chats, messages and documents share one
file, `ora.db`. A document context request takes a `budget` in characters (default 24000, clamped to 1000-400000).
A chat's documents that fit are sent whole, otherwise the best-ranked chunks are picked until the budget is used.

## Voice turns

Speech is transcribed first. The browser sends the utterance to the model with the system prompt `Perform ASR.`
at temperature 0, shows the returned words in the user's bubble (with a microphone mark), and stores them as
text with a `voice` flag. Audio is never kept: later turns, reloads and document search all use the words, and a
spoken sentence costs tens of tokens instead of thousands. The mic needs a model with audio input.

`src/web/vad.ts` decides when an utterance starts and ends from the microphone level. The pause that ends a turn
is a setting (default 0.9 s, 0.4 to 2.0 s). While the model is thinking or speaking, speech must be louder and
last about 250 ms before it counts, which keeps the model's own voice from cutting itself off. When it does count,
generation and speech stop and the new utterance is taken.

## Context

The saved chat is never cut. Before each reply a copy is trimmed to fit the context size minus the reply length:
first the images of the oldest messages are replaced by a note (the model's own description of each stays in the
text), then whole messages from the oldest end, always starting on a user turn and always keeping the newest
message. `src/web/history.ts` holds this logic. Sizes are estimated from characters and scaled by the ratio between
the estimate and the prompt size the server reported for the previous reply, so the estimate follows the real
tokenizer and image cost. Document text and PDF pages are added separately, within their own share of the budget.

## The web UI

The stylesheet (`src/web/style.css`) is written mobile first. The base rules are the phone layout: a slide-over chat
drawer, a metrics sheet behind a corner button, a settings bottom sheet, 44 px touch targets and 16 px form
text so iOS does not zoom. One query, `(min-width: 768px) and (min-aspect-ratio: 1/1)`, switches to the desktop
layout: a floating chat panel, metrics at the right from 1100 px, and a centred conversation. Portrait tablets use
the phone layout. The Inter variable font is bundled, so the page makes no font requests.

Replies are rendered as Markdown (paragraphs, headings, lists with nested items, quotes, code blocks, bold, italic,
inline code). `src/web/markdown.ts` turns text into plain data and the page builds elements from it with `textContent`, so model
output cannot inject HTML. An unfinished marker stays literal until it closes, which keeps streaming stable. While a
reply streams, `MarkdownStream` keeps the blocks that can no longer change and parses only the tail, so finished
paragraphs keep their elements and any text selected in them.

## The orb and the persona

The orb is drawn by a WGSL shader through vgpu: a glass sphere with eyes, and a dotted shell that responds to
load, context use and key-value cache use. Browsers without WebGPU get a 2D canvas version with the same eyes.
`src/web/persona.ts` holds the mood (valence, arousal, curiosity, strain), the current expression and a memory of
past conversations. The browser saves it to the server (`/api/persona`), which stores `persona.json`.

## Invariants

- The server binds to `127.0.0.1` and checks `Host` and `Origin` on every request.
- PDF rendering never runs in the server process when the child-process mode is on (the compiled binary).
- Generated files (`assets.gen.ts`, `ffi/*.gen.json`, `ffi/build/`, downloaded PDFium) are never committed.
- The embedded PDFium is checked against the SHA-256 in `ffi/pdfium.lock.json` before it is used.

## Out of scope

Accounts, TLS, remote access, text extraction from PDFs, and prebuilt binaries.
