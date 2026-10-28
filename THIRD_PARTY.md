# Third-party components

Code and binaries that go into Ora, with where they came from and how to check them.
npm packages are pinned by `package-lock.json`.

## Vendored in `ffi/vendor/`

| Component | Version | Licence | Source | File | SHA-256 |
|---|---|---|---|---|---|
| SQLite amalgamation | 3.54.1, source id `2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76` | Public domain | https://sqlite.org/download.html (amalgamation zip) | `sqlite3.c` | `0c657666d819f261cc4007526ad57e1669de9949df7a8ea847aa284a2bf0ee52` |
| SQLite header | 3.54.1 | Public domain | same archive | `sqlite3.h` | `d6c84557261893439b341d2e6c35187ae3ea24fbfd843ad94616f72d89242b8c` |
| `stb_image_write` (JPEG encoder) | v1.16 | Public domain (or MIT, at your option) | https://github.com/nothings/stb | `stb_image_write.h` | `cbd5f0ad7a9cf4468affb36354a1d2338034f2c12473cf1a8e32053cb6914a05` |

## PDFium (downloaded at build time)

PDFium is not stored in this repository. `npm run build` runs `scripts/fetch-pdfium.ts`, which downloads the
build for the machine doing the building from
https://github.com/bblanchon/pdfium-binaries (release `chromium/8125`, PDFium `158.0.8125.0`), verifies the
archive against the SHA-256 pinned in `ffi/pdfium.lock.json`, and keeps the library in the git-ignored
`ffi/vendor/pdfium/lib/<platform>/`.

| Platform | Asset | Archive SHA-256 |
|---|---|---|
| linux-x64 | `pdfium-linux-x64.tgz` | `e1c3ce6e270cb5e0c20816b379ad9f2c1309972697c505f508de92bf5e7d6659` |
| linux-arm64 | `pdfium-linux-arm64.tgz` | `8b8818f2ec57d1b213d952ca6d7f0ffeca9d0110487d0e20ad83ba918bc92efa` |
| darwin-arm64 | `pdfium-mac-arm64.tgz` | `4939bd935ac83ddc09a3a4f038bc43a19cea1660316a3667f26cb07a070e139d` |
| win32-x64 | `pdfium-win-x64.tgz` | `9a964261760cff52570aabf038ab346d3a5034dd8b30d0d5fe8861235d356b8b` |

Licence: BSD-3-Clause for PDFium. The library is a static build that bundles its own dependencies. Their licence
texts are kept unmodified, as shipped in the Linux x64 archive, in `ffi/vendor/pdfium/licenses/` (PDFium,
abseil, AGG, dragonbox, fast_float, FreeType, HarfBuzz, highway, ICU, lcms, libjpeg-turbo, OpenJPEG, libpng,
llvm-libc, simdutf, zlib). `ffi/vendor/pdfium/LICENSE` and `VERSION` are the packaging project's own files.
Anyone redistributing a compiled `ora` binary is redistributing this library and should ship that directory
with it.

### How the library is used

`ffi/orapdf.c` embeds the downloaded library into the binary with `.incbin` and loads it with `dlopen` on first
use. On Linux it goes through an anonymous in-memory file (`memfd_create`); on macOS, and on Linux if that fails,
it uses a temp file that is deleted right after loading. Windows cannot delete a loaded DLL, so it writes
`%TEMP%\ora-pdfium-<size>.dll` once and reuses it. Rendering runs in a child process of the same binary
(`ora --render-pdf`), so a malformed PDF can crash the child but not the server. The macOS and Windows paths are untested.

### Updating

1. Pick a release at https://github.com/bblanchon/pdfium-binaries/releases.
2. Update `release` and each platform's `asset` and `sha256` in `ffi/pdfium.lock.json`. GitHub shows each
   asset's SHA-256 on the release page.
3. Add `member` (the library's path inside the archive) for any new platform.
4. Refresh the licence files in `ffi/vendor/pdfium/` from the new archive and update this page.
5. Run `npm test`. It renders a page of known boxes and checks the pixels, so a broken renderer fails.

## npm dependencies that ship in the product

Only the web bundle's dependencies end up inside `bin/ora`: `vgpu` and `@vgpu/wgsl` (MIT) for the orb's WebGPU
rendering. Build and dev tools (`vite` MIT, `scriptc` Apache-2.0, `typescript` Apache-2.0, `lefthook` MIT) are
not shipped.
