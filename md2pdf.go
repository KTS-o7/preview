package main

import (
	"bytes"
	"context"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

const (
	md2pdfMaxBody = 10 << 20
	md2pdfTimeout = 30 * time.Second
	md2pdfQueue   = 10 * time.Second
)

// md2pdf converts Markdown to PDF with pandoc + wkhtmltopdf, one at a time:
// the VPS has a single CPU and wkhtmltopdf is the heaviest thing it runs.
type md2pdf struct {
	slot chan struct{}
}

func newMD2PDF() *md2pdf {
	return &md2pdf{slot: make(chan struct{}, 1)}
}

func (m *md2pdf) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, md2pdfMaxBody)
	markdown, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "body too large (max 10MB)", http.StatusRequestEntityTooLarge)
		return
	}
	if len(bytes.TrimSpace(markdown)) == 0 {
		http.Error(w, "empty markdown", http.StatusBadRequest)
		return
	}

	select {
	case m.slot <- struct{}{}:
		defer func() { <-m.slot }()
	case <-time.After(md2pdfQueue):
		http.Error(w, "busy, try again", http.StatusServiceUnavailable)
		return
	case <-r.Context().Done():
		return
	}

	tmpDir, err := os.MkdirTemp("", "md2pdf-")
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	defer os.RemoveAll(tmpDir)

	mdPath := filepath.Join(tmpDir, "input.md")
	pdfPath := filepath.Join(tmpDir, "output.pdf")
	if err := os.WriteFile(mdPath, markdown, 0o600); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), md2pdfTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "pandoc",
		mdPath,
		"-o", pdfPath,
		"--pdf-engine=wkhtmltopdf",
		"--metadata", "title=Document",
		"-V", "margin-top=15",
		"-V", "margin-bottom=15",
		"-V", "margin-left=15",
		"-V", "margin-right=15",
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	start := time.Now()
	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			http.Error(w, "conversion timed out", http.StatusGatewayTimeout)
			return
		}
		log.Printf("pandoc failed: %v: %s", err, stderr.String())
		http.Error(w, "PDF conversion failed", http.StatusInternalServerError)
		return
	}
	log.Printf("md2pdf: %d bytes in %v", len(markdown), time.Since(start).Round(time.Millisecond))

	pdf, err := os.ReadFile(pdfPath)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", `attachment; filename="document.pdf"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(pdf)))
	w.Write(pdf)
}
