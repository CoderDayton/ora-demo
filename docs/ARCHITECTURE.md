# Architecture

How the Ora binary is built and why each choice was made.

- [One binary](#one-binary)
- [PDFs become images](#pdfs-become-images)
- [Rendering runs in child processes](#rendering-runs-in-child-processes)
- [SQLite through FFI](#sqlite-through-ffi)
- [Turns](#turns)
- [Tools](#tools)
- [Conversation guard](#conversation-guard)
- [Auto mode](#auto-mode)
- [HTTP API](#http-api)
- [Voice turns](#voice-turns)
- [Spoken replies](#spoken-replies)
- [Context and the prompt cache](#context-and-the-prompt-cache)
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

A PDF is rendered to one JPEG per page and sent to the model as images, so figures and layout survive. The page
size is set by the `px` upload parameter: the UI offers 1024, 1536 or 2048 px on the longest side, the server
clamps it to 512-2400 (default 1024) and the renderer to 4096. At most 200 pages are rendered. PDFium is
used through `ffi/orapdf.c`, which reads pixels as BGRx (`FPDFBitmap_BGRx = 3`; the value 2 is 3-byte BGR and
garbles the page), converts them to RGB and encodes JPEG with the vendored `stb_image_write`.

The text layer (FPDFText) is read at upload too, but only to choose pages: each page's text is indexed in FTS5
(`page_fts`) and a question is routed to the pages that match it. The text is never sent to the model.

An upload returns once the page count and text are read and the source PDF is stored (`pages/<id>/source.pdf`).
The images are rendered afterwards in the background, in parallel ranges of pages. A page that is asked for before
its image exists is rendered on demand. Pages and the page index are kept in `ora.db`; the schema is versioned with
`pragma user_version`, and an older database is upgraded in place on open.

## Rendering runs in child processes

A malformed PDF can crash PDFium, and rendering is slow. The server never calls PDFium itself in compiled mode: it
runs the same binary as `ora --render-pdf pages <in> <outDir> <px> <from> <to>` (writes `<n>.jpg`, 1-based) or
`ora --render-pdf info <in> <out.json> <maxPages>` (page count and text). Children are spawned asynchronously, so
the event loop keeps serving requests and streaming replies while a large PDF renders. Each has a 120 s timeout
and exits 0, or 2 with the reason on stderr. A crash costs one upload, not the server.

The PDFium library is embedded in the binary. On Linux it loads from an anonymous in-memory file, on macOS from a
temp file deleted right after loading, and on Windows from `%TEMP%\ora-pdfium-<size>.dll`, written once and
reused because Windows cannot delete a loaded DLL. Third-party details are in
[../THIRD_PARTY.md](../THIRD_PARTY.md).

## SQLite through FFI

SQLite 3.54.1 is vendored and compiled in with FTS5. Documents are split into chunks and indexed with the
`porter unicode61` tokenizer, and search results are ranked with bm25. Chats, messages and documents share one
file, `ora.db`. A document context request takes a `budget` in characters (default 24000, clamped to 1000-400000).
A chat's documents that fit are sent whole, otherwise the best-ranked chunks are picked until the budget is used:
a chunk that does not fit is skipped rather than ending the search, the best hits bring their neighbouring chunks,
consecutive chunks of one document are joined into one excerpt (the chunk overlap is removed), and the query is the
last two user messages so a follow-up still finds its text.

## Turns

The server owns a turn. `POST /api/turn` takes the chat id, the text, any images, the system prompt, the sampling
settings and the PDF page ranges the user typed, and streams server-sent events: `chat`, `user`, `note`, `delta`
and a final `done` with usage, timings and the share of the prompt served from the cache. The server stores the
question before calling the model and the reply when it ends, including a reply cut off by the user, so a closed tab
or a switched chat loses nothing. Closing the connection cancels the request to `llama-server`. The browser renders
events and handles audio input and output.

`POST /api/asr` transcribes one utterance.

Source layout, by feature: `src/server/{engine,llm,chat,docs,store,tools}/` and `src/web/{chat,voice,orb}/`, with
the entry points (`index.ts`, `config.ts`, `app.ts`, `state.ts`) at each root. Tests mirror it under `test/`.

## Tools

The model can call tools during a turn. `POST /api/turn` takes `tools`, a list of group names; the server
intersects it with the config's `tools` ceiling, so the page cannot enable a group the config does not allow.
Definitions are sent in the OpenAI `tools` format. A turn runs at most 8 rounds (completion, tool calls, results);
the last round is sent without definitions so the model must answer. The final reply is stored as an `assistant`
message, and the steps (name, summary, result, up to 1500 characters) as one `tool` message just before it, so a
reloaded chat shows what ran. The steps also keep the call's arguments, and later turns replay each as an assistant tool call plus the saved result, so a follow-up can use what a search found. The page switches `docs` and `utility` on by
default (kept under `ora.tools` in the browser) and shows the active groups in a chip beside the composer. Calibration of the context estimate is skipped on turns that used tools.

| Group | Tools | Asks first |
|---|---|---|
| `docs` | `search_documents`, `read_document` | no |
| `utility` | `current_time`, `calculate` (a parser, never `eval`) | no |
| `web` | `web_search`, `web_fetch` | no |
| `system` | `run_command`, `read_file`, `write_file`, `list_dir` | every call |

- **Defaults:** `docs` and `utility` are allowed by the config; `web` and `system` need to be listed in `tools`,
  and the page's Tools settings start empty.
- **Web:** `web_fetch` allows http(s) only, refuses credentials in the URL, `localhost`, `.local`/`.internal` and
  private or loopback addresses (checked again on every redirect and after DNS resolution), follows at most 4
  redirects, times out at 15 s and returns at most 20000 characters. `web_search` calls `searchUrl` with `{q}`
  replaced; it fails with "not configured" when unset.
- **System:** files are confined to `workDir` (symlinks are resolved first); writes are capped at 1 MB. Commands run
  with `sh -c` in `workDir`, in their own process group, with a timeout and a 20000-character output cap.
- **Approval:** an asking tool emits `approval` and waits. The decision arrives from the Allow/Deny buttons, a typed
  word, or speech, through `POST /api/turn/approve`. Cancelling the turn denies it. The spoken answer is matched
  strictly (`src/web/chat/approval.ts`): only short replies made of yes/no words count, anything else is asked
  again, and speech does not interrupt the turn while a question is open.
- **Events:** `tool {id,name,summary,say,ask}`, `approval {id,name,summary}`, `tool_done {id,ok,denied,output}`.
  Tools that do not ask are announced by voice with `say`.

## Conversation guard

A small model copies what it sees: one generic reply in the history ("I'm LFM, the Liquid Foundation Model...") and it
gives the same one again. `src/server/chat/guard.ts` keeps this out of every turn, with or without auto mode:

- Before a reply, any turn whose reply occurs in two or more turns of the chat is left out of the prompt (replies under
  20 characters may repeat). The rows stay in the chat; only the prompt changes.
- While a reply streams, the first 40 characters are held back and compared with earlier replies. If it opens like one,
  the generation is cancelled before the page sees any of it, the turns it copies are left out, the temperature rises by
  0.3 (up to 1.0) and the reply is asked again once. The page gets a note.

## Auto mode

With `auto: true` on `POST /api/turn` (the "Auto" setting, on by default) the loaded model tunes the turn itself
(`src/server/chat/plan.ts`). Before the reply, one short non-streaming call (temperature 0, at most 120 tokens, on the
recognizer's slot so the chat's cached prompt is not evicted; skipped when the engine has one slot) is asked for a JSON
plan. The server clamps every value, ignores anything it cannot read, and streams the result as a `plan` event.

| Key | Range | Effect |
|---|---|---|
| `temperature` | 0 to 1.2 | Sampling temperature of the reply. |
| `maxTokens` | 64 to 2048 | Reply length, never above the user's own limit. |
| `tools` | groups on offer | Groups for this turn; `system` is offered only when the page switched it on. |
| `pageShare` | 0.1 to 0.6 | Share of the context for PDF page images when no text document is attached. |
| `speed` | 0.9 to 1.4 | Playback speed of this reply. |
| `pauseMs` | 600 to 1600 | How long to wait for the user's next words. |
| `memory` | 1 to 8 | How many of the latest earlier turns the question depends on; 8 or unset keeps the whole chat. The planner is shown the last eight turns as one short line each. |

A failed or unreadable plan is an empty plan and the turn uses the user's settings. Tool definitions are part of the
cached prompt, so in auto mode a chat only gains groups, never loses them. Auto turns also add a short instruction to
work step by step and allow 16 tool rounds instead of 8. Shell and file calls still ask every time.

In hands-free mode with Auto on, the page says so when it did not catch an utterance, and speaks up once after 45 s of
quiet.

## HTTP API

All routes are served on `127.0.0.1:<port>`. Errors are `{ "error": string }` with the status code. A request whose
`Host` is not `127.0.0.1:<port>` or `localhost:<port>` gets 403, as does a non-GET request with a foreign `Origin`.

| Route | Body limit | Result |
|---|---|---|
| `GET /api/models` | | Models and projectors found in the models folder. |
| `GET /api/status` | | Engine state: `stopped`, `starting`, `ready`, `stopping` or `error`. |
| `POST /api/start` | 64 KiB | Starts `llama-server` with `model`, `mmproj`, `ctx`, `reasoning`, `parallel` (default 2, range 1-8). 400 on a bad value. |
| `POST /api/stop` | | Stops it. |
| `POST /api/turn` | 48 MiB | Server-sent events, see [Turns](#turns). 400 on a bad body, 404 for an unknown chat. |
| `GET /api/tools` | | Tool groups with their tools, whether the config allows each, `workDir` and whether a search URL is set. |
| `POST /api/turn/approve` | 4 KiB | `{ id, decision: "allow" or "deny" }` answers a pending approval; returns `{ ok }` (false when none is waiting). |
| `POST /api/asr` | 16 MiB | `{ audio, language? }` (base64 WAV; `language` is a plain name such as `English`) returns `{ text }`. 400 without audio, 502 when the model call fails. |
| `GET`, `PUT /api/persona` | 64 KiB | The orb's memory (`persona.json`). |
| `GET`, `POST /api/chats` | 4 KiB | List chats; create one (`title` is cut to 120 characters). |
| `GET`, `PATCH`, `DELETE /api/chats/<id>` | 4 KiB | The chat with its messages and documents; rename; delete. |
| `DELETE /api/chats/<id>/messages?from=<messageId>` | | Deletes a question and the tool steps and reply after it, up to the next question. 404 when `from` is not a question of the chat. |
| `POST /api/chats/<id>/messages` | 32 MiB | Appends a `user` or `assistant` message. |
| `POST /api/chats/<id>/docs?name=&px=` | 64 MiB | Adds a PDF or text file. Text is cut into 1200-character chunks with 150 overlap, at most 8,000,000 characters (413 beyond that). 422 when the file cannot be read. |
| `GET /api/chats/<id>/context?q=&budget=` | | Document context for a question, see [SQLite through FFI](#sqlite-through-ffi). |
| `GET /api/docs/<id>/pages/<n>` | | One page as `image/jpeg`, `cache-control: private, max-age=86400`. |
| `DELETE /api/docs/<id>` | | Removes a document and its pages. |
| `/llama/*` | | Proxied to `llama-server` (the browser calls `/llama/tts` for speech). |

## Voice turns

Speech is transcribed first. The browser sends the utterance to `/api/asr`, which asks the model with the system
prompt `Perform ASR.` at temperature 0, shows the returned words in the user's bubble (with a microphone mark),
and stores them as text with a `voice` flag. Audio is never kept: later turns, reloads and document search all use
the words, and a spoken sentence costs tens of tokens instead of thousands. The mic needs a model with audio input.

`src/web/voice/vad.ts` decides when an utterance starts and ends from the microphone level. The pause that ends a turn
is a setting (default 0.9 s, 0.4 to 2.0 s). While the model is thinking or speaking, speech must be louder and
last about 250 ms before it counts, which keeps the model's own voice from cutting itself off. When it does count,
generation and speech stop and the new utterance is taken.

Transcription is speculative: after a 0.3 s pause the VAD reports `pause` and the browser starts transcribing what
it has. Speech that resumes (`resume`) drops that transcription and recording continues; if the full pause passes
first, the words are usually ready. The microphone is read by an AudioWorklet (frames of 2048 samples at the
device's rate, downsampled to 16 kHz for the model), with a ScriptProcessor fallback.

The recognizer is asked for the language set in Settings (default English, or auto-detect), and with English a transcript
that reads as another language is dropped like any other noise. A turn can be removed from the transcript with the
button on its question; the chat is then reloaded from the server.

The server caps a transcription at `6 x seconds + 24` tokens (32 to 400), so a clip of noise cannot turn into a long
invented passage. The page then drops a transcript that is empty or a single word that is not a plain command
(`src/web/voice/transcript.ts`: "One.", "on." are dropped, "Yes." and "Stop." are kept) and says it did not catch it. A transcript that trails off ("What's the...") or ends on a
word like "the" or "to" is held for 12 s and joined to the next utterance, so one question is not sent as two turns.
The metrics panel shows the last transcription time as `asr ms`.

## Spoken replies

With "Speak replies" on, the text of a reply follows the voice instead of racing ahead of it. The reply streams in
as usual, but the browser holds it back and shows only what has been spoken (`R.cap` in `src/web/voice/speech.ts` is the
number of characters of the reply that are visible).

- Playback speed is the "Speaking speed" setting (0.8x to 1.5x, default 1.2x). It is applied as the audio
  source's `playbackRate`, so pitch rises a little with speed, and the text reveal is paced to the sped-up length.
- The reply is split into sentences as it streams: a chunk ends at `.`, `!` or `?` followed by whitespace, or at a
  newline, and a chunk shorter than 24 characters is joined with the next one. Markdown marks and code blocks are
  removed before synthesis, so they are never spoken.
- Each chunk is sent to `/llama/tts` as soon as it is complete, so the next sentence is synthesised while the
  current one plays. Chunks play in order, one at a time, through the Web Audio API.
- When a chunk starts playing, its text is uncovered evenly over the length of its audio, a whole word at a time
  (`requestAnimationFrame`). When it ends, the text up to the end of the chunk is shown.
- If the next sentence is not ready, both the voice and the text wait. A chunk whose synthesis fails is shown at once.
- Stopping, interrupting by voice or switching speech off shows the rest of the reply immediately. The stored reply
  is always the full text.

Nothing is reordered on the server: the delay exists only in what the page shows. Before the first sentence's audio
arrives the reply bubble is empty, so the start of a reply is delayed by the first synthesis. With speech off, text
appears as it streams.

## Context and the prompt cache

`llama-server` reuses the cached start of a slot's previous prompt, so the server builds each prompt to keep its
start identical from turn to turn (`src/server/chat/prompt.ts`). The order is: system prompt (plus whole documents when
they fit), the PDF pages, the history, and last the question. Document excerpts chosen for this question are added
to the last user message, so they never change what comes before it. Replies run on slot 0 and transcription on
slot 1 (`id_slot`; the engine starts with two slots), so one does not evict the other's cache. The `done` event
reports `timings.cache_n / (cache_n + prompt_n)`, shown as "prompt cache" in the metrics panel.

The saved chat is never cut. Before each reply a copy is trimmed to fit the context size minus the reply length:
first the images of the oldest messages are replaced by a note (the model's own description of each stays in the
text), then whole messages from the oldest end, always starting on a user turn and always keeping the newest
message. The cut is sticky: the start point and image stripping are kept per chat and reused while the history
still fits, and when it no longer fits the history is cut down to 75% of the budget, so the cached start is reused
for many turns instead of being invalidated by every new message. Sizes are estimated from characters and scaled by
the ratio between the estimate and the prompt size the server reported for the previous reply.

PDF pages are chosen per question: pages the user typed for a document are sent as given; otherwise the pages whose
text matches the question (up to the space left in the context) are sent, falling back to the first pages. The set
sent to a chat is sticky too: it is kept while the best matches are still in it, because changing the pages
invalidates the cache after them.

## The web UI

The stylesheet (`src/web/style.css`) is written mobile first. The base rules are the phone layout: a slide-over chat
drawer, a metrics sheet behind a corner button, a settings bottom sheet, 44 px touch targets and 16 px form
text so iOS does not zoom. One query, `(min-width: 768px) and (min-aspect-ratio: 1/1)`, switches to the desktop
layout: a floating chat panel, metrics at the right from 1100 px, and a centred conversation. Portrait tablets use
the phone layout. The Inter variable font is bundled, so the page makes no font requests.

Replies are rendered as Markdown (paragraphs, headings, lists with nested items, quotes, code blocks, bold, italic,
inline code). `src/web/chat/markdown.ts` turns text into plain data and the page builds elements from it with `textContent`, so model
output cannot inject HTML. An unfinished marker stays literal until it closes, which keeps streaming stable. While a
reply streams, `MarkdownStream` keeps the blocks that can no longer change and parses only the tail, so finished
paragraphs keep their elements and any text selected in them.

## The orb and the persona

The orb is drawn by a WGSL shader (`src/web/orb/orb.wgsl`) through vgpu: a glass sphere with eyes, and a shell of
dots on a latitude/longitude grid (200 latitude bands) that responds to load, context use and key-value cache use.
The eyes are tinted with the orb's hue and sit on a soft dark shadow, so they stay readable on a bright body.
Browsers without WebGPU get a 2D canvas version (`src/web/orb/orb.ts`, "canvas 2d" in the metrics panel) with the same
eyes: 600 particles about 0.3 to 0.9 px in radius, and a 1 px ring with a tick every 6 degrees (longer every 30)
that shows context use as an arc and key-value cache use as dashes. The body is drawn with normal compositing,
because adding light every frame on top of the trail fade saturates to a flat white disc.
`src/web/orb/persona.ts` holds the mood (valence, arousal, curiosity, strain), the current expression and a memory of
past conversations. The browser saves it to the server (`/api/persona`), which stores `persona.json`.

## Invariants

- The server binds to `127.0.0.1` and checks `Host` and `Origin` on every request.
- PDF rendering never runs in the server process when the child-process mode is on (the compiled binary).
- Nothing synchronous waits on a child process or on PDFium in the server, so a large PDF cannot stall a streaming reply.
- Generated files (`assets.gen.ts`, `ffi/*.gen.json`, `ffi/build/`, downloaded PDFium) are never committed.
- The embedded PDFium is checked against the SHA-256 in `ffi/pdfium.lock.json` before it is used.

## Out of scope

Accounts, TLS, remote access, sending PDF text to the model (it is read only to choose pages), and prebuilt binaries.
