package main

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"testing"

	"github.com/xuri/excelize/v2"
)

func TestXLSXRoundTrip(t *testing.T) {
	srv := newTestServer(t)

	src := excelize.NewFile()
	src.SetCellValue("Sheet1", "A1", "hello")
	src.SetCellValue("Sheet1", "A2", 1)
	buf, err := src.WriteToBuffer()
	if err != nil {
		t.Fatal(err)
	}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "in.xlsx")
	fw.Write(buf.Bytes())
	mw.Close()
	resp, err := http.Post(srv.URL+"/api/xlsx/upload", mw.FormDataContentType(), &body)
	if err != nil {
		t.Fatal(err)
	}
	var up workbookInfo
	json.NewDecoder(resp.Body).Decode(&up)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || up.ID == "" || len(up.Sheets) != 1 {
		t.Fatalf("upload: status %d, %+v", resp.StatusCode, up)
	}
	if up.Sheets[0].Cells[0][0] != "hello" {
		t.Fatalf("uploaded A1 = %q", up.Sheets[0].Cells[0][0])
	}

	for _, e := range []editPayload{
		{"Sheet1", 1, 1, "changed"}, // string
		{"Sheet1", 2, 1, "42.5"},    // number
		{"Sheet1", 3, 1, "=A2*2"},   // formula
	} {
		b, _ := json.Marshal(e)
		resp, err := http.Post(srv.URL+"/api/xlsx/"+up.ID+"/edit", "application/json", bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("edit %+v: status %d", e, resp.StatusCode)
		}
	}

	// Reads after an edit show computed formula values, not stale caches.
	resp, err = http.Get(srv.URL + "/api/xlsx/" + up.ID)
	if err != nil {
		t.Fatal(err)
	}
	var got workbookInfo
	json.NewDecoder(resp.Body).Decode(&got)
	resp.Body.Close()
	if v := got.Sheets[0].Cells[2][0]; v != "85" {
		t.Errorf("read A3 = %q, want 85", v)
	}

	resp, err = http.Get(srv.URL + "/api/xlsx/" + up.ID + "/download")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(resp.Header.Get("Content-Disposition"), "attachment") {
		t.Fatalf("download: status %d, %v", resp.StatusCode, resp.Header)
	}
	out, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	if v, _ := out.GetCellValue("Sheet1", "A1"); v != "changed" {
		t.Errorf("A1 = %q, want changed", v)
	}
	if v, _ := out.GetCellValue("Sheet1", "A2"); v != "42.5" {
		t.Errorf("A2 = %q, want 42.5", v)
	}
	if f, _ := out.GetCellFormula("Sheet1", "A3"); f != "A2*2" {
		t.Errorf("A3 formula = %q, want A2*2", f)
	}
}
