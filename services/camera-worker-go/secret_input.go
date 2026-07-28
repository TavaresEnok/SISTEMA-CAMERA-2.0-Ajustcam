package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
)

const secretInputProtocols = "file,pipe,tcp,udp,rtp,rtsp,http,https,tls"

var secretInputOptionNames = map[string]bool{
	"-analyzeduration": true,
	"-err_detect":      true,
	"-fflags":          true,
	"-flags":           true,
	"-max_delay":       true,
	"-probesize":       true,
	"-rtsp_transport":  true,
	"-rw_timeout":      true,
	"-stimeout":        true,
	"-timeout":         true,
	"-user_agent":      true,
}

func secretConcatDocument(secretURL string, inputOptions ...[2]string) (string, error) {
	if len(secretURL) == 0 || len(secretURL) > 16*1024 || strings.ContainsAny(secretURL, "\x00\r\n") {
		return "", fmt.Errorf("URL secreta inválida")
	}
	parsed, err := url.Parse(secretURL)
	if err != nil || parsed.Host == "" {
		return "", fmt.Errorf("URL secreta inválida")
	}
	switch parsed.Scheme {
	case "rtsp", "rtsps", "http", "https":
	default:
		return "", fmt.Errorf("protocolo de URL secreta não permitido")
	}
	escaped := strings.ReplaceAll(secretURL, "'", "'\\''")
	var document strings.Builder
	document.WriteString("ffconcat version 1.0\nfile '")
	document.WriteString(escaped)
	document.WriteString("'\n")
	for _, option := range inputOptions {
		name, value := option[0], option[1]
		if name == "" || value == "" || len(value) > 4096 || strings.ContainsAny(name+value, "\x00\r\n") {
			return "", fmt.Errorf("opção inválida para o canal privado")
		}
		for _, char := range name {
			if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '_') {
				return "", fmt.Errorf("opção inválida para o canal privado")
			}
		}
		document.WriteString("option ")
		document.WriteString(name)
		document.WriteString(" ")
		document.WriteString(strings.ReplaceAll(value, "'", "'\\''"))
		document.WriteString("\n")
	}
	return document.String(), nil
}

func prepareSecretURLInput(args []string, secretURL string) ([]string, string, error) {
	index := -1
	for i, value := range args {
		if value != secretURL {
			continue
		}
		if index >= 0 {
			return nil, "", fmt.Errorf("o comando deve conter exatamente uma URL secreta")
		}
		index = i
	}
	if index < 0 {
		return nil, "", fmt.Errorf("o comando deve conter exatamente uma URL secreta")
	}
	start := index
	if index > 0 && args[index-1] == "-i" {
		start = index - 1
	}
	secured := make([]string, 0, len(args)+8)
	inputOptions := make([][2]string, 0)
	for cursor := 0; cursor < start; cursor++ {
		name := args[cursor]
		if secretInputOptionNames[name] {
			if cursor+1 >= start {
				return nil, "", fmt.Errorf("opção %s sem valor", name)
			}
			inputOptions = append(inputOptions, [2]string{strings.TrimPrefix(name, "-"), args[cursor+1]})
			cursor++
			continue
		}
		secured = append(secured, name)
	}
	secured = append(secured,
		"-protocol_whitelist", secretInputProtocols,
		"-f", "concat",
		"-safe", "0",
		"-i", "pipe:3",
	)
	secured = append(secured, args[index+1:]...)
	document, err := secretConcatDocument(secretURL, inputOptions...)
	if err != nil {
		return nil, "", err
	}
	return secured, document, nil
}

func replaceSecretURLWithPipe(args []string, secretURL string) ([]string, error) {
	secured, _, err := prepareSecretURLInput(args, secretURL)
	return secured, err
}

func secretURLCommand(
	ctx context.Context,
	binary string,
	args []string,
	secretURL string,
) (*exec.Cmd, func(), error) {
	securedArgs, document, err := prepareSecretURLInput(args, secretURL)
	if err != nil {
		return nil, nil, err
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, nil, fmt.Errorf("criar pipe privado: %w", err)
	}

	cmd := exec.CommandContext(ctx, binary, securedArgs...)
	// ExtraFiles[0] sempre se torna fd 3 no processo filho.
	cmd.ExtraFiles = []*os.File{reader}
	// A escrita precisa ocorrer em paralelo: a capacidade do pipe varia por
	// kernel e um URL/manifesto grande não pode bloquear antes de cmd.Start()
	// criar o leitor no processo filho.
	writeDone := make(chan struct{})
	go func() {
		defer close(writeDone)
		_, _ = writer.WriteString(document)
		_ = writer.Close()
	}()
	cleanup := func() {
		_ = reader.Close()
		_ = writer.Close()
		<-writeDone
	}
	return cmd, cleanup, nil
}
