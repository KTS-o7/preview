# preview

Private, lightweight file toolbox at **<https://preview.shenthar.me>**.

Drop a file to view or edit it. Most tools run entirely in the browser, so the
file never leaves your machine. One Go binary with the frontend embedded; no
JavaScript build step.

| Tool | What it does | Runs in |
|---|---|---|
| PDF | View with the browser's viewer | browser |
| DOCX | View pages, zoom, print | browser |
| XLSX | View and edit cells, formulas, sheets; download | **server** (memory only) |
| CSV / TSV | Sort, filter, edit; 200k rows stay smooth | browser |
| Markdown | Live preview; export `.md`, HTML, PDF | browser (PDF export: server) |
| JSON | Format, minify, sort keys, tree, exact error location | browser |
| Diff | Unified, split and word diffs; JSON-aware mode | browser (Web Worker) |
| Image | Zoom, pan, dimensions | browser |
| Text | View and edit, fallback for unknown types | browser |

Supersedes [xl-vps](https://github.com/KTS-o7/xl-vps) and
[md2pdf](https://github.com/KTS-o7/md2pdf).

## Privacy

- Only XLSX editing and Markdown→PDF send file contents to the server.
- Workbooks are held in memory and dropped after 30 minutes idle. Nothing is
  written to disk except pandoc's per-request temp directory.
- The page ships a strict Content-Security-Policy: scripts only from this
  origin, rendered Markdown is sanitised with DOMPurify, and PDF export drops
  raw HTML and runs wkhtmltopdf without JavaScript or local file access.

## Layout

```
main.go          router, embedded static serving, CSP
xlsx.go          in-memory workbook store (excelize), eviction, memory budget
md2pdf.go        pandoc + wkhtmltopdf, one conversion at a time, 30 s timeout
static/          index.html shell, app.js router, lib/ (pure logic), tools/ (one ES module per tool), vendor/
test/            bun tests for static/lib
deploy/          systemd unit, nginx vhost
scripts/         deploy.sh (build, ship, health check, rollback), smoke.sh
```

## Develop

```bash
go run .                 # http://127.0.0.1:8092
go test ./...            # md2pdf test needs pandoc + wkhtmltopdf, else skips
bun install && bun test
bunx tsc --noEmit -p jsconfig.json
```

Static files are embedded at build time, so restart after editing them.

## Deploy

```bash
scripts/deploy.sh        # cross-compiles, copies to the VPS, restarts, rolls back on failed health check
scripts/smoke.sh         # live checks: health, CSP, xlsx upload/download, md2pdf
```

## Limits

- Uploads: 50 MB. Markdown→PDF: 10 MB.
- XLSX formulas are recalculated for sheets up to 100k cells; larger sheets
  show the values Excel cached. Very large workbooks (500k+ cells) use a few
  hundred MB while open; older workbooks are dropped when memory runs high.

## License

MIT
