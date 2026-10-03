package main

// XLSX store: upload a workbook, keep it parsed in memory, read ranges, edit
// single cells, download. Port of KTS-o7/xl-vps src/main.rs onto excelize.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"runtime"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/xuri/excelize/v2"
)

const (
	xlsxMaxUpload   = 50 << 20
	xlsxMaxEdit     = 1 << 20
	xlsxIdleTimeout = 30 * time.Minute
	xlsxMaxEntries  = 100
	xlsxSweepEvery  = time.Minute
	xlsxMIME        = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	xlsxMinRows     = 20 // minimum grid so a fresh sheet is not cramped
	xlsxMinCols     = 8
	// Checking cells for formulas makes excelize load the whole worksheet
	// model (~0.5 KB per cell), so it only happens for windows up to this size.
	xlsxCalcCells = 100_000
	// Above this heap size, least recently used workbooks are dropped early.
	// The unit runs with GOMEMLIMIT=300MiB and MemoryMax=512M.
	xlsxHeapBudget = 250 << 20
)

type workbook struct {
	mu         sync.Mutex // guards f, closed and edited
	f          *excelize.File
	closed     bool
	edited     bool         // formula caches may be stale; recalculate on read
	lastAccess atomic.Int64 // unix nanoseconds
}

func (w *workbook) touch() { w.lastAccess.Store(time.Now().UnixNano()) }

type xlsxStore struct {
	mu sync.RWMutex
	wb map[string]*workbook
}

func newXLSXStore() *xlsxStore {
	return &xlsxStore{wb: map[string]*workbook{}}
}

type sheetInfo struct {
	Name  string     `json:"name"`
	Rows  int        `json:"rows"`
	Cols  int        `json:"cols"`
	Cells [][]string `json:"cells"`
}

type workbookInfo struct {
	ID     string      `json:"id"`
	Sheets []sheetInfo `json:"sheets"`
}

type editPayload struct {
	Sheet string `json:"sheet"`
	Row   int    `json:"row"`
	Col   int    `json:"col"`
	Value string `json:"value"`
}

func (s *xlsxStore) register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/xlsx/upload", s.upload)
	mux.HandleFunc("GET /api/xlsx/{id}", s.read)
	mux.HandleFunc("POST /api/xlsx/{id}/edit", s.edit)
	mux.HandleFunc("GET /api/xlsx/{id}/download", s.download)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand failing is unrecoverable
	}
	return hex.EncodeToString(b[:])
}

// lookup returns the workbook and marks it as used.
func (s *xlsxStore) lookup(id string) *workbook {
	s.mu.RLock()
	wb := s.wb[id]
	s.mu.RUnlock()
	if wb != nil {
		wb.touch()
	}
	return wb
}

// withBook runs fn holding the workbook lock. It writes the 404 itself when
// the id is unknown or the workbook was evicted meanwhile.
func (s *xlsxStore) withBook(w http.ResponseWriter, id string, fn func(wb *workbook)) {
	wb := s.lookup(id)
	if wb == nil {
		expired(w)
		return
	}
	wb.mu.Lock()
	defer wb.mu.Unlock()
	if wb.closed {
		expired(w)
		return
	}
	fn(wb)
}

func expired(w http.ResponseWriter) {
	writeErr(w, http.StatusNotFound, "workbook expired, re-upload")
}

func (s *xlsxStore) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, xlsxMaxUpload)
	mr, err := r.MultipartReader()
	if err != nil {
		writeErr(w, http.StatusBadRequest, "expected multipart upload")
		return
	}
	var f *excelize.File
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			uploadErr(w, err)
			return
		}
		if part.FormName() != "file" {
			continue
		}
		f, err = excelize.OpenReader(part, excelize.Options{
			UnzipSizeLimit:    256 << 20, // zip-bomb guard; the service is capped at 512M RSS
			UnzipXMLSizeLimit: 16 << 20,  // larger sheet XML spills to temp files
		})
		if err != nil {
			uploadErr(w, err)
			return
		}
		break
	}
	if f == nil {
		writeErr(w, http.StatusBadRequest, "missing 'file' field")
		return
	}

	id := newID()
	info := workbookInfo{ID: id, Sheets: []sheetInfo{}}
	for _, name := range f.GetSheetList() {
		si, err := describeSheet(f, name, "", false)
		if err != nil {
			f.Close()
			writeErr(w, http.StatusBadRequest, "cannot read sheet: "+err.Error())
			return
		}
		info.Sheets = append(info.Sheets, si)
	}
	wb := &workbook{f: f}
	wb.touch()
	s.mu.Lock()
	s.wb[id] = wb
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, info)
	s.trimMemory(id)
}

func uploadErr(w http.ResponseWriter, err error) {
	var tooBig *http.MaxBytesError
	if errors.As(err, &tooBig) {
		writeErr(w, http.StatusRequestEntityTooLarge, "file too large (max 50MB)")
		return
	}
	writeErr(w, http.StatusBadRequest, "not a valid .xlsx file: "+err.Error())
}

func (s *xlsxStore) read(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	rng := r.URL.Query().Get("range")
	s.withBook(w, id, func(wb *workbook) {
		info := workbookInfo{ID: id, Sheets: []sheetInfo{}}
		for _, name := range wb.f.GetSheetList() {
			si, err := describeSheet(wb.f, name, rng, wb.edited)
			if err != nil {
				writeErr(w, http.StatusInternalServerError, err.Error())
				return
			}
			info.Sheets = append(info.Sheets, si)
		}
		writeJSON(w, http.StatusOK, info)
	})
}

func (s *xlsxStore) edit(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var p editPayload
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, xlsxMaxEdit)).Decode(&p); err != nil {
		writeErr(w, http.StatusBadRequest, "bad JSON body")
		return
	}
	if p.Row < 1 || p.Col < 1 {
		writeErr(w, http.StatusBadRequest, "row/col are 1-based")
		return
	}
	cell, err := excelize.CoordinatesToCellName(p.Col, p.Row)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.withBook(w, id, func(wb *workbook) {
		if idx, err := wb.f.GetSheetIndex(p.Sheet); err != nil || idx < 0 {
			writeErr(w, http.StatusBadRequest, "sheet '"+p.Sheet+"' not found")
			return
		}
		if err := setCell(wb.f, p.Sheet, cell, p.Value); err != nil {
			writeErr(w, http.StatusUnprocessableEntity, "spreadsheet error: "+err.Error())
			return
		}
		wb.edited = true
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id})
	})
	s.trimMemory(id)
}

// setCell applies xl's rules: "" clears, leading "=" is a formula, anything
// that parses as a finite number is numeric, the rest is a string.
func setCell(f *excelize.File, sheet, cell, value string) error {
	if err := f.SetCellValue(sheet, cell, nil); err != nil { // drop old value and formula
		return err
	}
	switch {
	case value == "":
		return nil
	case value[0] == '=':
		return f.SetCellFormula(sheet, cell, value[1:])
	}
	if n, ok := parseNumber(value); ok {
		return f.SetCellFloat(sheet, cell, n, -1, 64)
	}
	return f.SetCellStr(sheet, cell, value)
}

// parseNumber is strconv.ParseFloat minus the Go-only spellings (hex floats,
// underscores, inf, nan) that a spreadsheet user would mean as text.
func parseNumber(s string) (float64, bool) {
	if strings.ContainsAny(s, "xX_pP") {
		return 0, false
	}
	n, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
		return 0, false
	}
	return n, true
}

func (s *xlsxStore) download(w http.ResponseWriter, r *http.Request) {
	s.withBook(w, r.PathValue("id"), func(wb *workbook) {
		buf, err := wb.f.WriteToBuffer()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "spreadsheet error: "+err.Error())
			return
		}
		h := w.Header()
		h.Set("Content-Type", xlsxMIME)
		h.Set("Content-Disposition", `attachment; filename="workbook.xlsx"`)
		h.Set("Content-Length", strconv.Itoa(buf.Len()))
		h.Set("Cache-Control", "no-store")
		w.Write(buf.Bytes())
	})
}

// describeSheet reads one sheet. Dimensions follow xl: the data extent with a
// 20x8 minimum, clamped to the requested range when there is one. The result
// is rows x cols with "" for blanks.
//
// excelize returns the values Excel cached for formula cells. Once the
// workbook has been edited those caches can be stale (or empty for new
// formulas), so recalc evaluates every formula cell in the window. Without
// recalc only blank cells are checked for an uncached formula.
func describeSheet(f *excelize.File, name, rng string, recalc bool) (sheetInfo, error) {
	r1, c1, r2, c2 := parseA1Range(rng)
	loRow, loCol := max(r1, 1), max(c1, 1)

	rows, err := f.Rows(name)
	if err != nil {
		return sheetInfo{}, err
	}
	defer rows.Close()

	var kept [][]string // rows loRow..r2, columns loCol..c2, unpadded
	maxRow, maxCol, rn := 0, 0, 0
	for rows.Next() {
		rn++
		cols, err := rows.Columns()
		if err != nil {
			return sheetInfo{}, err
		}
		last := len(cols)
		for last > 0 && cols[last-1] == "" {
			last--
		}
		if last > 0 {
			maxRow = rn
			maxCol = max(maxCol, last)
		}
		if rn < loRow || rn > r2 {
			continue
		}
		var part []string
		if loCol <= last {
			part = append(part, cols[loCol-1:min(last, c2)]...)
		}
		for len(kept) < rn-loRow {
			kept = append(kept, nil)
		}
		kept = append(kept, part)
	}
	if err := rows.Error(); err != nil {
		return sheetInfo{}, err
	}

	hiRow := min(r2, max(maxRow, xlsxMinRows))
	hiCol := min(c2, max(maxCol, xlsxMinCols))
	if hiRow < loRow || hiCol < loCol {
		return sheetInfo{Name: name, Cells: [][]string{}}, nil
	}
	nr, nc := hiRow-loRow+1, hiCol-loCol+1
	checkFormulas := nr*nc <= xlsxCalcCells
	cells := make([][]string, nr)
	for i := range cells {
		cells[i] = make([]string, nc)
		if i < len(kept) {
			copy(cells[i], kept[i])
		}
		if !checkFormulas {
			continue
		}
		for j := range cells[i] {
			// Files written by scripts (openpyxl, pandas) store formulas
			// without cached values, so blanks are always checked.
			if !recalc && cells[i][j] != "" {
				continue
			}
			ref, _ := excelize.CoordinatesToCellName(loCol+j, loRow+i)
			if formula, _ := f.GetCellFormula(name, ref); formula != "" {
				if v, err := f.CalcCellValue(name, ref); err == nil {
					cells[i][j] = v
				} else {
					cells[i][j] = "#ERROR"
				}
			}
		}
	}
	return sheetInfo{Name: name, Rows: nr, Cols: nc, Cells: cells}, nil
}

const unbounded = math.MaxInt32

// parseA1Range parses "A1:Z100" into (row1, col1, row2, col2). Anything that
// is not a "X:Y" pair means the whole sheet.
func parseA1Range(s string) (r1, c1, r2, c2 int) {
	a, b, ok := strings.Cut(strings.ToUpper(strings.TrimSpace(s)), ":")
	if !ok {
		return 0, 0, unbounded, unbounded
	}
	ra, ca := parseA1(a)
	rb, cb := parseA1(b)
	return min(ra, rb), min(ca, cb), max(ra, rb), max(ca, cb)
}

func parseA1(s string) (row, col int) {
	s = strings.TrimSpace(s)
	i := strings.IndexAny(s, "0123456789")
	if i < 0 {
		i = len(s)
	}
	for _, ch := range s[:i] {
		if ch >= 'A' && ch <= 'Z' {
			col = min(col*26+int(ch-'A'+1), 1<<20)
		}
	}
	col = max(col, 1)
	row = 1
	if n, err := strconv.Atoi(s[i:]); err == nil && n > 0 {
		row = n
	}
	return row, col
}

// evictLoop drops workbooks idle for 30 minutes, then the least recently used
// until at most 100 remain. It runs until ctx is cancelled.
func (s *xlsxStore) evictLoop(ctx context.Context) {
	t := time.NewTicker(xlsxSweepEvery)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n := s.evict(time.Now()); n > 0 {
				log.Printf("xlsx: evicted %d workbooks", n)
			}
		}
	}
}

func (s *xlsxStore) evict(now time.Time) int {
	type entry struct {
		id string
		wb *workbook
		at int64
	}
	s.mu.Lock()
	var dropped []*workbook
	var live []entry
	for id, wb := range s.wb {
		at := wb.lastAccess.Load()
		if now.Sub(time.Unix(0, at)) > xlsxIdleTimeout {
			delete(s.wb, id)
			dropped = append(dropped, wb)
		} else {
			live = append(live, entry{id, wb, at})
		}
	}
	if len(live) > xlsxMaxEntries {
		sort.Slice(live, func(i, j int) bool { return live[i].at < live[j].at })
		for _, e := range live[:len(live)-xlsxMaxEntries] {
			delete(s.wb, e.id)
			dropped = append(dropped, e.wb)
		}
	}
	s.mu.Unlock()

	closeBooks(dropped)
	return len(dropped)
}

// closeBooks closes evicted workbooks outside the map lock; an in-flight
// request on one of them finishes first.
func closeBooks(dropped []*workbook) {
	for _, wb := range dropped {
		wb.mu.Lock()
		wb.closed = true
		wb.f.Close()
		wb.mu.Unlock()
	}
}

// trimMemory drops least recently used workbooks, never keep, while the heap
// is over budget. Big edited sheets cost hundreds of MB each, so the count
// cap alone does not bound memory.
func (s *xlsxStore) trimMemory(keep string) {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	if ms.HeapAlloc <= xlsxHeapBudget {
		return
	}
	s.mu.Lock()
	type entry struct {
		id string
		wb *workbook
	}
	var others []entry
	for id, wb := range s.wb {
		if id != keep {
			others = append(others, entry{id, wb})
		}
	}
	sort.Slice(others, func(i, j int) bool {
		return others[i].wb.lastAccess.Load() < others[j].wb.lastAccess.Load()
	})
	// Without per-workbook sizes, drop the older half (at least one).
	n := max(1, len(others)/2)
	var dropped []*workbook
	for _, e := range others[:min(n, len(others))] {
		delete(s.wb, e.id)
		dropped = append(dropped, e.wb)
	}
	s.mu.Unlock()
	if len(dropped) == 0 {
		return
	}
	closeBooks(dropped)
	debug.FreeOSMemory()
	log.Printf("xlsx: heap %d MiB over budget, dropped %d workbooks", ms.HeapAlloc>>20, len(dropped))
}
