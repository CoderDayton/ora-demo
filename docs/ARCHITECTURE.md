# Architecture

How the Ora binary is built and why each choice was made.

- [One binary](#one-binary)
- [PDFs become images](#pdfs-become-images)
- [Rendering runs in a child process](#rendering-runs-in-a-child-process)
- [SQLite through FFI](#sqlite-through-ffi)
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
