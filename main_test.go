package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path"
	"strings"
	"testing"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	assets, err := loadAssets()
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(newMux(assets, newXLSXStore()))
	t.Cleanup(srv.Close)
	return srv
}

// Every embedded file must be reachable with the right Content-Type: a JS
// module served as anything but text/javascript silently breaks import().
func TestStaticAssetsServeWithCorrectType(t *testing.T) {
	srv := newTestServer(t)
	assets, _ := loadAssets()
	want := map[string]string{
		".html": "text/html", ".css": "text/css", ".js": "text/javascript",
	}
	for p := range assets {
		resp, err := http.Get(srv.URL + p)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("%s: status %d", p, resp.StatusCode)
		}
		if w, ok := want[path.Ext(p)]; ok && !strings.HasPrefix(resp.Header.Get("Content-Type"), w) {
			t.Errorf("%s: Content-Type %q, want %s", p, resp.Header.Get("Content-Type"), w)
		}
	}
	if _, ok := assets["/index.html"]; !ok {
		t.Fatal("index.html not embedded")
	}
}

func TestMD2PDF(t *testing.T) {
	for _, bin := range []string{"pandoc", "wkhtmltopdf"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Skipf("%s not on PATH", bin)
		}
	}
	srv := newTestServer(t)
	cases := []struct {
		name       string
		body       []byte
		wantStatus int
		wantPrefix string
	}{
		{"converts markdown", []byte("# Title\n\nSome *text*.\n"), http.StatusOK, "%PDF"},
		{"rejects empty body", []byte("  \n"), http.StatusBadRequest, ""},
		{"rejects oversized body", bytes.Repeat([]byte("a"), md2pdfMaxBody+1), http.StatusRequestEntityTooLarge, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			resp, err := http.Post(srv.URL+"/api/md2pdf", "text/markdown", bytes.NewReader(c.body))
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != c.wantStatus {
				t.Fatalf("status %d, want %d", resp.StatusCode, c.wantStatus)
			}
			if c.wantPrefix != "" {
				var buf bytes.Buffer
				buf.ReadFrom(resp.Body)
				if !bytes.HasPrefix(buf.Bytes(), []byte(c.wantPrefix)) {
					t.Fatalf("body starts %q, want %q", buf.Bytes()[:min(8, buf.Len())], c.wantPrefix)
				}
			}
		})
	}
}
