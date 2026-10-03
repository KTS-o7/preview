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
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"os/signal"
	"path"
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
		sum := sha256.Sum256(body)
		a := &asset{
			body:        body,
			contentType: typeFor(p),
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
		assets["/"+p] = a
		return nil
	})
	return assets, err
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
		a, ok := assets[p]
		if !ok {
			http.NotFound(w, r)
			return
		}
		h := w.Header()
		h.Set("Content-Type", a.contentType)
		h.Set("Cache-Control", "no-cache")
		h.Set("ETag", a.etag)
		h.Set("Vary", "Accept-Encoding")
		if strings.HasPrefix(a.contentType, "text/html") {
			h.Set("Content-Security-Policy", csp)
			// no-transform stops Cloudflare injecting its analytics beacon,
			// which the CSP would block anyway.
			h.Set("Cache-Control", "no-cache, no-transform")
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
