package main

import (
	"context"
	"strings"
	"testing"
)

func TestReplaceSecretURLWithPipeRemovesCredentialFromArgv(t *testing.T) {
	secret := "rtsp://camera-user:camera-password@192.168.50.20:554/live"
	args := []string{"-rtsp_transport", "tcp", "-i", secret, "-f", "null", "-"}
	secured, err := replaceSecretURLWithPipe(args, secret)
	if err != nil {
		t.Fatal(err)
	}
	argv := strings.Join(secured, "\x00")
	for _, forbidden := range []string{secret, "camera-user", "camera-password"} {
		if strings.Contains(argv, forbidden) {
			t.Fatalf("argv ainda contém segredo: %q", forbidden)
		}
	}
	if !strings.Contains(argv, "pipe:3") {
		t.Fatal("argv não usa pipe privado")
	}
}

func TestSecretURLCommandUsesInheritedFD(t *testing.T) {
	secret := "rtsp://user:pass@192.168.50.20:554/live"
	cmd, cleanup, err := secretURLCommand(
		context.Background(),
		"ffmpeg",
		[]string{"-i", secret, "-f", "null", "-"},
		secret,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer cleanup()
	if len(cmd.ExtraFiles) != 1 {
		t.Fatalf("esperava um fd herdado; recebeu %d", len(cmd.ExtraFiles))
	}
	if strings.Contains(strings.Join(cmd.Args, "\x00"), "user:pass") {
		t.Fatal("credencial permaneceu nos argumentos")
	}
}

func TestSecretConcatDocumentRejectsControlsAndLocalFile(t *testing.T) {
	if _, err := secretConcatDocument("rtsp://host/live\nfile x"); err == nil {
		t.Fatal("controle de linha deveria ser recusado")
	}
	if _, err := secretConcatDocument("file:///etc/passwd"); err == nil {
		t.Fatal("protocolo file deveria ser recusado")
	}
}
