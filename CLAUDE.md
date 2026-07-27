# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — run the server (`node server.js`), serves the IDE at http://localhost:5000 (`PORT` env var overrides).
- `npm run setup` / `setup.bat` / `setup.ps1` — install Node deps and verify Node + JDK are present.
- There is **no build step and no project-level test suite**. `npm test` is an unconfigured stub that exits 1. "Running tests" in this project means executing *user's Java JUnit tests inside the IDE* via the `/api/test` endpoint, not testing this codebase.

Requires a JDK 11+ on the host with `javac`/`java`/`jdb` reachable (via `JAVA_HOME`, standard install dirs, or `PATH`).

## Architecture

This is a browser-based Java IDE: a Node/Express backend shells out to the host JDK to compile, run, debug, and test Java code, streaming I/O to a single-page frontend.

- **`server.js`** — the entire backend and the only file `npm start` runs. Express serves static files + JSON HTTP APIs; a `ws` WebSocket server (same HTTP server) handles interactive/streaming work. Key shared helpers at the top drive everything:
  - `getSystemJdkPath()` / `getBinaries(userJdk)` — locate the JDK. A user-supplied path (sent from the frontend as `jdkPath`) overrides auto-detection; falls back to bare command names on PATH.
  - `setupWorkspace(files, dir)` — writes the incoming file array to disk and returns the `.java` paths. `getClasspath(dir)` — builds classpath as the workspace dir plus every `.jar` in `lib/`.
  - `resolveMainClass(files, default)` — picks the entry class by scanning file contents for `static void main` and extracting package + class name.
  - `parseJavacOutput()` — turns `javac` stderr into Monaco marker objects (severity 8 = error, 4 = warning) for inline squiggles.
- **`public/index.html`** — the entire frontend (~966 lines, all inline HTML/CSS/JS, no bundler). Loads Monaco editor and xterm.js from CDN with a graceful fallback to a native `<textarea>`/HTML terminal if the CDN is blocked (see the "Universal Terminal Wrapper" near the top of the `<script>`). Talks to the backend over `fetch` (HTTP APIs) and one WebSocket.
- **`server1.js`** — a legacy/minimal single-file runner. **Not wired to any npm script and not used**; `server.js` is the real backend. Don't edit `server1.js` expecting it to affect the app.

### Request flow

- **HTTP (`fetch`)**: `/api/lint` (compile-only → markers), `/api/run` (compile + run with a 15s timeout, non-interactive fallback), `/api/test` (compile + run the bundled JUnit console JAR with `--scan-class-path`), `/api/dependencies[/add]` (list / download JARs into `lib/`), `/api/export` (zip `temp_workspace` via adm-zip), `/api/jdk-path`, and the `/api/ai/*` endpoints.
- **WebSocket** (message `type` field routes): `run_interactive` (compile then `spawn` `java`, stream stdout/stderr), `terminal_input` (forward xterm keystrokes to the process stdin), `debug_start` (compile with `-g`, spawn `jdb`, set breakpoints), `debug_command` (forward a raw jdb command, e.g. `cont`/`next`/`step`/`step up`), `debug_inspect` (dump an object), `debug_stop` (kill the jdb session). Each socket tracks at most one `runningAppProcess` and one `runningJdbProcess`, killed on new run or disconnect.

  **Visual execution debugger:** on every stop, `handleJdbOutput` (in `server.js`) drives `jdb` non-interactively — it issues `locals` + `where` terminated by a `print "<sentinel>"` marker, buffers the streamed output across chunks, then parses it into a structured `debug_state` message (typed variables, scopes, and call-stack frames). Two jdb quirks are handled deliberately and must be preserved: (1) `jdb` prepends its prompt (`main[1] `) to the first output line, so `stripJdbPrompt` runs per line; (2) `print`/`dump` are evaluated on the target VM and their output ordering is unreliable — for `locals`/`where` the sentinel reliably lands last, but for `dump` it does not, so object inspection detects completion structurally (a closing brace or an error string) with a timeout fallback rather than via sentinel. The authoritative current location comes from the top stack frame, not the stop banner (which can span chunk boundaries).

### Things to know before changing behavior

- **`temp_workspace/` is a single shared, mutable compile dir** — every request and every connected client writes to the same directory (`path.join(__dirname, 'temp_workspace')`). There is no per-user or per-session isolation. Files are overwritten, not cleaned up (checked-in `.class`/`.java` artifacts there are stale scratch output, safe to ignore).
- **The `/api/ai/*` endpoints are not real AI.** `fix` is regex/string heuristics for a few known errors, `generate-tests` returns a hardcoded stub test, `explain` returns computed file stats. There is no LLM call anywhere. Don't assume model integration exists.
- **No sandboxing.** The server compiles and executes arbitrary user-supplied Java (and downloads arbitrary JAR URLs into `lib/`) with the host process's privileges. Treat this as a local-only dev tool; keep that in mind for any change touching process spawning or the dependency downloader.
- Compilation is always JDK-driven (`javac`); the frontend's Monaco language service is only for editing—real errors come from the backend `lint`/`run` responses.
