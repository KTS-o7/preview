# preview.shenthar.me: design

Date: 2026-10-03
Status: approved in conversation, pending spec review

## Goal

One private, lightweight toolbox at `https://preview.shenthar.me` for viewing and
editing files. Nothing is stored. Most tools run entirely in the browser, so the
file never reaches the server.

It replaces two existing services on the personal VPS:

- `xl.shenthar.me`: xlsx viewer/editor, Rust, repo `KTS-o7/xl-vps`
- `pdf.shenthar.me`: Markdown to PDF, Go wrapper around pandoc, repo `KTS-o7/md2pdf`

### Success criteria

- Every tool in the scope table works at 1366x768 @ 125% zoom and at mobile width.
- Landing page is at most 15 KB gzipped.
- Server idle RSS is at most 15 MB on the VPS.
- Only xlsx and md-to-pdf send file contents to the server.
- `xl.shenthar.me` and `pdf.shenthar.me` redirect into the new site; both old
  services are stopped and both old repos are archived.

## Scope

| Tool | View | Edit | Runs in | Notes |
|---|---|---|---|---|
| PDF | yes | no | browser | Native browser viewer via blob URL |
| DOCX | yes | no | browser | `docx-preview` + `jszip` |
| CSV / TSV | yes | yes | browser | Own RFC 4180 parser, virtualised grid |
| Markdown | yes | yes | browser | `marked` + `DOMPurify`; PDF export uses server |
| JSON | yes | yes | browser | Pretty-print, minify, sort keys, tree, error location |
| Text | yes | yes | browser | Plain textarea; fallback for unknown types |
| Images | yes | no | browser | Zoom, pan, dimensions, size |
| Diff | n/a | n/a | browser | Unified, split and word styles; `jsdiff` in a Web Worker |
| XLSX | yes | yes | server | Port of xl-vps behaviour to Go + `excelize` |
| MD to PDF | n/a | n/a | server | Port of md2pdf; exposed as Markdown's "Export PDF" |

Out of scope: DOCX editing, PPTX, syntax highlighting, accounts, saved history,
share links, persistence of any kind.

## Architecture

One Go binary. The frontend is static files embedded with `//go:embed`. No
JavaScript bundler: the browser loads native ES modules.

```
preview/
  go.mod
  main.go           router, /healthz, embedded static serving, startup/shutdown
  xlsx.go           in-memory workbook store, upload/read/edit/download, eviction
  md2pdf.go         pandoc invocation with limits
  main_test.go      server tests (see Testing)
  static/
    index.html      shell: header, full-page drop zone, tool grid, hash router
    app.css         shared dark theme (colours from xl-vps)
    app.js          router + file-type detection
    tools/          one ES module per tool, loaded with import() on first use
      pdf.js docx.js csv.js md.js json.js text.js image.js diff.js xlsx.js
    lib/            own pure logic shared by tools and tests
      csv.js        parse/serialise, delimiter detection
      detect.js     file-type detection
      diffview.js   JSON normalisation, hunk building and collapsing
      jsonloc.js    locate a JSON syntax error as line:column
      diff.worker.js
    vendor/         pinned minified third-party files, versions in vendor/VERSIONS
  test/             bun tests for static/lib
  scripts/
    deploy.sh       build, upload, restart, health check, rollback
    smoke.sh        post-deploy checks against the live site
  deploy/
    preview.service systemd unit
    nginx.conf      vhost template
```

### Routing

- Client routes are hash-based: `/#/pdf`, `/#/csv`, `/#/diff`, and so on. The
  server only serves `/`, static assets, `/healthz` and `/api/*`.
- A dropped or picked file stays in memory as a `File` object and is handed to
  the tool module. No upload happens except for xlsx and md-to-pdf.

### File-type detection (`lib/detect.js`)

1. Map the extension to a tool.
2. Check magic bytes from the first 8 bytes: `%PDF` for pdf, `PK\x03\x04` for
   docx/xlsx (both are zip, so the extension decides between them), PNG, JPEG,
   GIF and WebP signatures for images.
3. If the extension and bytes disagree, show "This file says .pdf but isn't a
   PDF" and offer to open it as text.
4. Unknown extension: "Can't preview .xyz yet", with an "Open as text" button.

### Static serving

- Files are embedded at build time. Each response sets the correct
  `Content-Type`. JS must be `text/javascript`, otherwise `import()` fails.
- Gzip is applied at build time for text assets and served when the client
  accepts it.
- `index.html` uses `Cache-Control: no-cache`. Other assets use a
  content-hash `ETag` with `no-cache` revalidation. Hashed filenames are not
  needed at this size.

## Tools

Every tool accepts a dropped file or pasted text and has a Download button.

### PDF
Blob URL in a full-height `<iframe>`. On iOS Safari, where inline PDFs render
only the first page, show an "Open in new tab" button instead.

### DOCX (view only)
`docx-preview` renders pages into the DOM. Zoom and print controls. A `.doc`
file (OLE magic `D0 CF 11 E0`) shows "Word 97 format not supported, save as
.docx".

### CSV / TSV
- Delimiter auto-detected from `,` `;` tab `|` by consistent field counts over
  the first 50 lines. A manual override is available.
- Header-row toggle, column sort, filter box, cell edit, add/delete row and
  column.
- Virtualised rendering: only visible rows are in the DOM.
- Download serialises with the original delimiter and line ending, and keeps
  a leading BOM if the input had one.

### Markdown
- Editor on the left, live preview on the right, synced scroll. GFM tables and
  task lists.
- Preview HTML goes through DOMPurify before insertion.
- Export: `.md`, standalone `.html`, and PDF through `POST /api/md2pdf`.

### JSON
- Pretty-print with 2 spaces, 4 spaces or tabs; minify; sort keys.
- Collapsible tree view.
- On parse failure, `lib/jsonloc.js` scans the input and reports the first
  invalid token as `line:column`, independent of the browser's error message.
  The editor highlights that position.

### Diff
- Two input panes, paste or drop.
- Styles:
  1. Unified: GitHub default, `-`/`+` lines with intra-line word highlight.
  2. Split: old left, new right, dual line numbers, synced scroll.
  3. Word: flowing text with deleted words struck in red and added words in
     green, like `git diff --word-diff`.
- Options: ignore whitespace, JSON-aware mode (parse both sides, sort keys,
  pretty-print, then diff), context lines (default 3).
- Unchanged runs longer than the context collapse to "Expand N lines".
- Header shows `+added −removed`.
- Diffing runs in `diff.worker.js` so large inputs don't block the UI.

### XLSX
- Same features as xl-vps: drag-drop, grid view, cell edit with string, number
  and `=formula` detection, sheet tabs, range reads, download.
- The page states that the file is uploaded to the server and held in memory
  for up to 30 minutes idle.
- The grid UI is adapted from xl-vps `static/index.html`.

### Images
Native `<img>` with zoom and pan. Shows pixel dimensions and file size.

## Server API

| Method | Path | Behaviour |
|---|---|---|
| GET | `/healthz` | `200 ok` |
| POST | `/api/xlsx/upload` | Multipart file → `{id, sheets}` |
| GET | `/api/xlsx/{id}?range=A1:Z100` | `{id, sheets}`; `range` optional, applied to every sheet |
| POST | `/api/xlsx/{id}/edit` | `{sheet, row, col, value}` (1-based; empty value clears) → `{ok, id}` |
| GET | `/api/xlsx/{id}/download` | Serialised `.xlsx` |
| POST | `/api/md2pdf` | Markdown body → `application/pdf` |

Request and response shapes for xlsx match xl-vps `src/main.rs` so the ported
grid UI works without changes, apart from the path prefix. Each sheet is
`{name, rows, cols, cells}` where `cells` is a `[row][col]` array of strings,
blank cells as `""`.

### XLSX store
- `map[id]*workbook` behind a `sync.RWMutex`. Each workbook has its own
  `sync.Mutex` around the `excelize.File` and a last-accessed time.
- A goroutine runs every 60 s: drop workbooks idle for 30 minutes, then drop
  least-recently-used entries until at most 100 remain.
- Upload limit 50 MB (`http.MaxBytesReader`), matching nginx.
- Unknown id returns 404 with `{"error":"workbook expired, re-upload"}`. The UI
  shows that message.

### md2pdf
- Body limit 10 MB, as in md2pdf today. Empty body returns 400.
- Same pandoc arguments as md2pdf today (`--pdf-engine=wkhtmltopdf`, 15 mm
  margins).
- New: 30 s timeout via `context.WithTimeout`, and at most one conversion at a
  time (buffered-channel semaphore). A second concurrent request waits up to
  10 s, then gets 503 "busy, try again". The VPS has one CPU.
- Temp files go in a per-request `os.MkdirTemp` directory, removed afterwards.

## Deployment

### Build
`scripts/deploy.sh`, run on the Mac:

1. `GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o dist/preview .`
2. `scp` to `personal:/opt/preview/preview.new`.
3. On the VPS: move the current binary to `preview.prev`, move `preview.new`
   into place, `systemctl restart preview`.
4. `curl -fsS https://preview.shenthar.me/healthz`. On failure, restore
   `preview.prev`, restart, and exit non-zero.

No Go or Rust toolchain is needed on the VPS.

### VPS
- `/opt/preview/`, owned by `deploy`.
- `preview.service`: `User=deploy`, `Environment=PORT=8092`,
  `Environment=GOMEMLIMIT=150MiB`, `MemoryMax=256M`, `NoNewPrivileges=yes`,
  `PrivateTmp=yes`, `Restart=on-failure`. Binds `127.0.0.1:8092`.
- nginx vhost `preview.shenthar.me`, copied from xl's: shared
  `security-headers`, `rate-limit` and `proxy-params` snippets,
  `client_max_body_size 50M`, certificate from certbot.
- Cloudflare: proxied `A` record `preview` → `192.3.228.223`, created with `cf`.
- pandoc and wkhtmltopdf are already installed at `/usr/bin`.

### Cut-over
Each step is verified before the next.

1. Deploy preview.shenthar.me and run `scripts/smoke.sh`. Check every tool by
   hand at both viewport sizes.
2. `xl.shenthar.me` → `301` to `https://preview.shenthar.me/#/xlsx`.
3. `pdf.shenthar.me` → `301` to `https://preview.shenthar.me/#/md`.
   Both old vhosts keep their certificates so HTTPS redirects work.
4. Stop and disable `xl.service` and `md2pdf.service`. Keep `/opt/xl-vps` and
   `/opt/md2pdf-vps` for 7 days as a rollback path, then delete them.
5. Add a "Superseded by KTS-o7/preview" note to the README of `KTS-o7/xl-vps`
   and `KTS-o7/md2pdf`, then archive both repos.
6. Record the new service, port and cut-over in the private `infra` repo's
   `memory.md`.

Rollback before step 4: revert the nginx redirects. After step 4: re-enable
the old units; the binaries are still in place.

## Testing

Tests cover only our own logic where a regression would be silent. Third-party
behaviour (jsdiff output, excelize internals, browser PDF rendering) is not
re-tested.

### Go (`go test ./...`)
1. XLSX round trip: upload a small fixture, edit a string cell, a number cell
   and a formula cell, download, re-open with excelize, and assert all three
   values and the formula.
2. md2pdf, table-driven: a short Markdown input returns a body starting with
   `%PDF`; an 11 MB body returns 413; an empty body returns 400. Skipped when
   pandoc is not on `PATH`.
3. Static assets: walk the embedded FS, request every file, and assert `200`
   plus the expected `Content-Type` for its extension.

### Browser logic (`bun test`, against `static/lib/*.js`)
1. `csv.js`, table-driven: quoted commas, escaped quotes, newline inside a
   quoted field, BOM, CRLF, delimiter detection for `,` `;` tab `|`, and
   parse-then-serialise returning the original text.
2. `diffview.js`: JSON-aware mode treats reordered keys as equal; collapsing
   keeps exactly N context lines around each change and reports the hidden
   count correctly.
3. `jsonloc.js`: invalid inputs report the expected `line:column`.
4. `detect.js`, table-driven: each supported type, a mismatched
   extension/magic pair, a `.doc` file, and an unknown extension.

### Checks
- `gofmt -l .` is empty, `go vet ./...` passes.
- `// @ts-check` in every `static/` JS file with JSDoc types;
  `bunx tsc --noEmit` passes.
- GitHub Actions runs all of the above on push.

### Manual verification before calling it done
- Screenshot of every tool at 1366x768 @ 125% zoom and at mobile width
  (390 px), using Brave devtools device emulation.
- Fixtures: one PDF, DOCX, CSV, Markdown, JSON and XLSX file, plus a
  200k-row CSV for grid performance.
- Budgets: landing page gzipped size, and `ps -o rss= -C preview` on the VPS.

### Post-deploy (`scripts/smoke.sh`)
Against the live site: `/healthz`, one xlsx upload through nginx, one
md-to-pdf conversion. These cover the nginx body limit and pandoc on the VPS,
which local tests cannot reach.
