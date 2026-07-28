package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFetchCamerasHonorsContextDeadline(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(200 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, err := fetchCameras(ctx, server.URL, "token-de-teste")
	if err == nil {
		t.Fatal("fetchCameras deveria falhar por deadline")
	}
	if elapsed := time.Since(started); elapsed > 150*time.Millisecond {
		t.Fatalf("deadline não interrompeu o request a tempo: %s", elapsed)
	}
}

func TestWaitForContextStopsImmediatelyOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	if waitForContext(ctx, time.Minute) {
		t.Fatal("waitForContext não pode sinalizar timer concluído após cancelamento")
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("cancelamento demorou demais: %s", elapsed)
	}
}

func TestRecordingStopCancelsItsContext(t *testing.T) {
	parent := context.Background()
	ctx, cancel := context.WithCancel(parent)
	const cameraID = "camera-test"

	mu.Lock()
	activeRecordings[cameraID] = true
	recordingCancels[cameraID] = cancel
	stopRecordingLocked(cameraID)
	mu.Unlock()

	select {
	case <-ctx.Done():
	case <-time.After(100 * time.Millisecond):
		t.Fatal("stopRecordingLocked não cancelou o contexto da gravação")
	}
}
