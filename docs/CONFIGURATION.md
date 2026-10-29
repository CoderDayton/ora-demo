# Configuration

Every setting Ora reads, where it looks, and what it creates on disk.

## Order

Environment variables win, then `~/.config/ora/config.json`, then the defaults. A bad value in the file (wrong
type, or a port outside range) falls back to the default.

## Settings

| `config.json` key | Environment variable | Default |
|---|---|---|
| `port` | `ORA_PORT` | `8800` |
| `llamaPort` | `ORA_LLAMA_PORT` | `8099` |
| `llamaServer` | `ORA_LLAMA_SERVER` | `llama-server` (looked up on `PATH`) |
| `llamaArgs` | `ORA_LLAMA_ARGS` | none; a list in the file, space-separated in the variable |
| `modelsDir` | `ORA_MODELS_DIR` | `models/` next to `config.json` |
| `dataDir` | `ORA_DATA` | `~/.local/share/ora` |
| `distDir` | `ORA_DIST` | unset: serve the embedded web app; set: serve the web files from this folder |
| `tools` | `ORA_TOOLS` | `["docs", "utility"]`: tool groups the page may switch on (`docs`, `utility`, `web`, `system`). Env is comma-separated; `none` allows no group. |
| `modelFilter` | `ORA_MODEL_FILTER` | unset: the picker lists every model found. Set (e.g. `lfm3`): only models whose path contains it, ignoring case |
| `workDir` | `ORA_WORKDIR` | `<dataDir>/work`: the only folder the `system` tools can read, write or run commands in |
| `searchUrl` | `ORA_SEARCH_URL` | unset: `web_search` is unavailable. A URL with `{q}`, e.g. a local SearXNG `http://127.0.0.1:8080/search?format=json&q={q}` |

`ORA_CONFIG` points at a different config file. `XDG_CONFIG_HOME` and `XDG_DATA_HOME` move the config and data
folders. Where `HOME` is unset (Windows), `USERPROFILE` stands in for it, so the paths keep the same layout.

`llamaArgs` go after Ora's own `llama-server` flags and can override them, for example
`{ "llamaArgs": ["-ngl", "0"] }` for a CPU-only run. Ora's own flags are `-m`, `-ngl 99`, `-c`, `-np`,
`--kv-unified`, `--reasoning`, `--metrics`, `--host 127.0.0.1`, `--port`, and `--mmproj` when a projector is
chosen.

## Models folder

On first start Ora creates the folder and writes a `README.txt` in it. It never overwrites that file. Put `.gguf`
files directly in the folder or one level down, one subfolder per model. A projector is a `.gguf` with `mmproj`
in its name beside the model. The folder is scanned each time the page loads.

## Data folder

| File | Holds |
|---|---|
| `ora.db` | Chats, documents and their full-text index (SQLite). |
| `pages/<document id>/` | The uploaded PDF (`source.pdf`) and its rendered page images (`<n>.jpg`). Missing images are rendered again when asked for. |
| `persona.json` | The orb's memory of past conversations. A corrupt file is ignored. |

## Build-time variables

| Variable | Effect |
|---|---|
| `ORA_PDFIUM_LIB` | Path to a PDFium shared library to embed instead of downloading one. |
| `CC`, `AR` | Compiler and archiver for the native library (defaults `clang`, then `ar` or `llvm-ar`). |
