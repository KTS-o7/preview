package main

import (
	"context"
	"net/http"
)

// STUB: replaced by the excelize port of xl-vps.
type xlsxStore struct{}

func newXLSXStore() *xlsxStore { return &xlsxStore{} }

func (s *xlsxStore) register(mux *http.ServeMux) {}

func (s *xlsxStore) evictLoop(ctx context.Context) { <-ctx.Done() }
