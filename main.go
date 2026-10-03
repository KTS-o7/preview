// preview: private, lightweight file toolbox (preview.shenthar.me).
//
// One binary. The frontend in static/ is embedded and served as-is; most
// tools run entirely in the browser. Only /api/xlsx and /api/md2pdf touch
// file contents on the server.
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path"
	"sort"
	"strings"
	"syscall"
	"time"
)

//go:embed static
var staticFS embed.FS

// asset is one embedded file, prepared once at startup.
type asset struct {
	body        []byte
	gz          []byte // nil when compression doesn't help
	contentType string
	etag        string
}

// contentTypes pins the types we rely on. JS modules must be text/javascript
// or import() fails, and the OS mime table varies between machines.
var contentTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".json": "application/json",
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".ico":  "image/x-icon",
	".txt":  "text/plain; charset=utf-8",
}

// csp applies to the HTML shell. Tools render untrusted documents (Markdown,
// DOCX), so scripts only come from our own origin. Blob frames and images
// cover the PDF and image viewers; https images allow remote Markdown images.
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' blob: data: https:; font-src 'self' data:; frame-src blob:; " +
	"worker-src 'self'; connect-src 'self'; object-src blob:; base-uri 'none'; form-action 'none'"

func typeFor(name string) string {
	ext := strings.ToLower(path.Ext(name))
	if t, ok := contentTypes[ext]; ok {
		return t
	}
	if t := mime.TypeByExtension(ext); t != "" {
		return t
	}
	return "application/octet-stream"
}

// loadAssets reads every embedded file under static/ and keys it by URL path.
func loadAssets() (map[string]*asset, error) {
	sub, err := fs.Sub(staticFS, "static")
	if err != nil {
		return nil, err
	}
	assets := map[string]*asset{}
	err = fs.WalkDir(sub, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		body, err := fs.ReadFile(sub, p)
		if err != nil {
			return err
		}
		assets["/"+p] = newAsset(p, body)
		return nil
	})
	if err != nil {
		return nil, err
	}

	// The build hash covers every file, so /v/<build>/ URLs change on each
	// deploy that changes anything and can be cached forever.
	names := make([]string, 0, len(assets))
	for name := range assets {
		names = append(names, name)
	}
	sort.Strings(names)
	h := sha256.New()
	for _, name := range names {
		io.WriteString(h, name+assets[name].etag)
	}
	build := hex.EncodeToString(h.Sum(nil)[:6])

	// index.html points at the versioned shell and preloads its imports, so
	// the browser fetches them in parallel instead of one after another.
	idx, ok := assets["/index.html"]
	if !ok {
		return nil, errors.New("static/index.html missing")
	}
	v := "/v/" + build + "/"
	html := strings.NewReplacer(
		`href="/app.css"`, `href="`+v+`app.css"`,
		`<script type="module" src="/app.js"></script>`,
		`<script type="module" src="`+v+`app.js"></script>`+"\n"+
			`<link rel="modulepreload" href="`+v+`lib/ui.js">`+"\n"+
			`<link rel="modulepreload" href="`+v+`lib/detect.js">`,
	).Replace(string(idx.body))
	if strings.Count(html, v) != 4 {
		return nil, errors.New("index.html: app.css/app.js tags not found for versioning")
	}
	assets["/index.html"] = newAsset("index.html", []byte(html))
	return assets, nil
}

func newAsset(name string, body []byte) *asset {
	sum := sha256.Sum256(body)
	a := &asset{
		body:        body,
		contentType: typeFor(name),
		etag:        `"` + hex.EncodeToString(sum[:8]) + `"`,
	}
	if strings.HasPrefix(a.contentType, "text/") || strings.Contains(a.contentType, "json") || strings.Contains(a.contentType, "svg") {
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		zw.Write(body)
		zw.Close()
		if buf.Len() < len(body) {
			a.gz = buf.Bytes()
		}
	}
	return a
}

func staticHandler(assets map[string]*asset) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := r.URL.Path
		if p == "/" {
			p = "/index.html"
		}
		// /v/<build>/path is the same file with a far-future cache. Any build
		// id is accepted so a briefly stale index.html still loads.
		versioned := false
		if rest, ok := strings.CutPrefix(p, "/v/"); ok {
			if _, file, ok := strings.Cut(rest, "/"); ok {
				p, versioned = "/"+file, true
			}
		}
		a, ok := assets[p]
		if !ok {
			http.NotFound(w, r)
			return
		}
		h := w.Header()
		h.Set("Content-Type", a.contentType)
		h.Set("ETag", a.etag)
		h.Set("Vary", "Accept-Encoding")
		switch {
		case strings.HasPrefix(a.contentType, "text/html"):
			h.Set("Content-Security-Policy", csp)
			// Browsers revalidate every load; Cloudflare may keep it at the
			// edge for 5 minutes (deploy.sh purges it). no-transform stops
			// Cloudflare injecting its analytics beacon.
			h.Set("Cache-Control", "public, max-age=0, s-maxage=300, must-revalidate, no-transform")
		case versioned:
			h.Set("Cache-Control", "public, max-age=31536000, immutable")
		default:
			h.Set("Cache-Control", "no-cache")
		}
		if r.Header.Get("If-None-Match") == a.etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		body := a.body
		if a.gz != nil && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			h.Set("Content-Encoding", "gzip")
			body = a.gz
		}
		if r.Method == http.MethodHead {
			return
		}
		w.Write(body)
	}
}

func newMux(assets map[string]*asset, store *xlsxStore) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	store.register(mux)
	mux.Handle("POST /api/md2pdf", newMD2PDF())
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})
	mux.HandleFunc("/", staticHandler(assets))
	return mux
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8092"
	}
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = "127.0.0.1"
	}

	assets, err := loadAssets()
	if err != nil {
		log.Fatalf("load assets: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store := newXLSXStore()
	go store.evictLoop(ctx)

	srv := &http.Server{
		Addr:              addr + ":" + port,
		Handler:           newMux(assets, store),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		log.Printf("preview listening on %s (%d assets)", srv.Addr, len(assets))
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
}
