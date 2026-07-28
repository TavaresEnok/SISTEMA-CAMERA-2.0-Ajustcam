package main

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-redis/redis/v8"
)

var (
	activeRecordings  = make(map[string]bool)
	recordingSegments = make(map[string]int)
	recordingCancels  = make(map[string]context.CancelFunc)
	mu                sync.Mutex
)

const (
	apiRequestTimeout = 10 * time.Second
	healthAddress     = ":8000"
)

type Camera struct {
	ID                     string `json:"id"`
	Name                   string `json:"name"`
	IP                     string `json:"ip"`
	RtspPort               int    `json:"rtspPort"`
	Username               string `json:"username"`
	PasswordEncrypted      string `json:"passwordEncrypted"`
	RtspPath               string `json:"rtspPath"`
	Channel                int    `json:"channel"`
	Subtype                int    `json:"subtype"`
	RecordingChannel       *int   `json:"recordingChannel"`
	RecordingSubtype       *int   `json:"recordingSubtype"`
	Status                 string `json:"status"`
	RecordingEnabled       bool   `json:"recordingEnabled"`
	PreferredRtspTransport string `json:"preferredRtspTransport"`
	RecordingVideoCodec    string `json:"recordingVideoCodec"`
	RecordingWidth         int    `json:"recordingWidth"`
	RecordingHeight        int    `json:"recordingHeight"`
	RecordingFps           int    `json:"recordingFps"`
	RecordingBitrateKbps   int    `json:"recordingBitrateKbps"`
}

type RecordingCommand struct {
	Action         string `json:"action"`
	CameraID       string `json:"cameraId"`
	SegmentSeconds int    `json:"segmentSeconds"`
	RequestedAt    string `json:"requestedAt"`
}

func requireStrongEnv(name string, minLen int, blocked map[string]bool) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		log.Fatalf("%s é obrigatório.", name)
	}
	if len(value) < minLen {
		log.Fatalf("%s inválido: mínimo de %d caracteres.", name, minLen)
	}
	if blocked[value] {
		log.Fatalf("%s inseguro: valor padrão bloqueado.", name)
	}
	return value
}

func main() {
	fmt.Println("Camera Worker Go - Iniciando...")
	// Aviso alto e claro: quem sobe este worker precisa saber que a gravação dele
	// NÃO é a oficial. Ver o bloco de comentário em recorder.go (videoArgs).
	log.Println("=====================================================================")
	log.Println("ATENCAO: worker LEGADO. A gravacao aqui transcodifica para H.264")
	log.Println("baseline/ultrafast (com PERDA de qualidade e uso continuo de CPU).")
	log.Println("O pipeline oficial e o da API, que grava em COPIA sem reencode.")
	log.Println("Use apenas com RECORDING_CONTROL_MODE=worker e ciente da diferenca.")
	log.Println("=====================================================================")

	apiURL := os.Getenv("API_URL")
	if apiURL == "" {
		apiURL = "http://localhost:3000"
	}

	secretKey := requireStrongEnv("CAMERA_SECRET_KEY", 32, map[string]bool{
		"change_me_32_chars_minimum":         true,
		"change_me_32_chars_minimum_vms_key": true,
	})

	redisAddr := os.Getenv("REDIS_ADDR")
	if redisAddr == "" {
		redisAddr = "localhost:6379"
	}

	rdb := redis.NewClient(&redis.Options{
		Addr: redisAddr,
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	serviceToken := requireStrongEnv("INTERNAL_SERVICE_TOKEN", 24, map[string]bool{
		"change_me_service_token": true,
	})

	// Teste de conexão com Redis
	pingCtx, cancelPing := context.WithTimeout(ctx, apiRequestTimeout)
	_, err := rdb.Ping(pingCtx).Result()
	cancelPing()
	if err != nil {
		log.Printf("Aviso: Falha ao conectar no Redis: %v", err)
	} else {
		fmt.Println("Conectado ao Redis com sucesso!")
	}

	commandChannel := os.Getenv("WORKER_COMMAND_CHANNEL")
	if commandChannel == "" {
		commandChannel = "camera:commands"
	}
	go subscribeCommands(ctx, rdb, apiURL, serviceToken, commandChannel)

	healthServer := startHealthServer()
	defer func() {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := healthServer.Shutdown(shutdownCtx); err != nil {
			log.Printf("Falha ao encerrar health server: %v", err)
		}
		if err := rdb.Close(); err != nil {
			log.Printf("Falha ao encerrar Redis: %v", err)
		}
	}()

	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()
	for {
		fmt.Println("Verificando câmeras...")
		cameras, err := fetchCameras(ctx, apiURL, serviceToken)
		if err != nil {
			log.Printf("Erro ao buscar câmeras: %v", err)
		} else {
			// Limpar câmeras que não existem mais
			mu.Lock()
			currentCamIds := make(map[string]bool)
			for _, cam := range cameras {
				currentCamIds[cam.ID] = true
			}
			for id := range activeRecordings {
				if !currentCamIds[id] {
					fmt.Printf("[Worker] Câmera %s removida da lista. Parando gravações...\n", id)
					stopRecordingLocked(id)
				}
			}
			mu.Unlock()

			for _, cam := range cameras {
				mu.Lock()
				if cam.RecordingEnabled {
					if !activeRecordings[cam.ID] {
						fmt.Printf("[%s] Iniciando loop de gravação...\n", cam.Name)
						startRecordingLocked(ctx, cam, apiURL, serviceToken)
					}
				} else {
					if activeRecordings[cam.ID] {
						fmt.Printf("[%s] Gravação desativada. Parando loop...\n", cam.Name)
						stopRecordingLocked(cam.ID)
					}
				}
				mu.Unlock()

				go processCamera(ctx, cam, secretKey, apiURL, serviceToken)
			}
		}

		select {
		case <-ctx.Done():
			mu.Lock()
			for id := range activeRecordings {
				stopRecordingLocked(id)
			}
			mu.Unlock()
			log.Println("Worker encerrado por sinal.")
			return
		case <-ticker.C:
		}
	}
}

func startHealthServer() *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	server := &http.Server{
		Addr:              healthAddress,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
	}
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("Health server falhou: %v", err)
		}
	}()
	return server
}

func startRecordingLocked(parent context.Context, cam Camera, apiURL, serviceToken string) {
	recordingCtx, cancel := context.WithCancel(parent)
	activeRecordings[cam.ID] = true
	recordingCancels[cam.ID] = cancel
	go startRecording(recordingCtx, cam, apiURL, serviceToken)
}

func stopRecordingLocked(cameraID string) {
	if cancel := recordingCancels[cameraID]; cancel != nil {
		cancel()
	}
	delete(recordingCancels, cameraID)
	delete(activeRecordings, cameraID)
	delete(recordingSegments, cameraID)
}

func fetchCameras(ctx context.Context, apiURL, serviceToken string) ([]Camera, error) {
	requestCtx, cancel := context.WithTimeout(ctx, apiRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, "GET", apiURL+"/cameras/internal/list", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Service-Token", serviceToken)

	client := &http.Client{Timeout: apiRequestTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("status code erro: %d", resp.StatusCode)
	}

	var cameras []Camera
	if err := json.NewDecoder(resp.Body).Decode(&cameras); err != nil {
		return nil, err
	}

	return cameras, nil
}

func fetchCameraByID(ctx context.Context, apiURL, serviceToken, id string) (*Camera, error) {
	cameras, err := fetchCameras(ctx, apiURL, serviceToken)
	if err != nil {
		return nil, err
	}
	for _, cam := range cameras {
		if cam.ID == id {
			return &cam, nil
		}
	}
	return nil, fmt.Errorf("camera %s não encontrada", id)
}

func subscribeCommands(ctx context.Context, rdb *redis.Client, apiURL, serviceToken, channel string) {
	pubsub := rdb.Subscribe(ctx, channel)
	defer pubsub.Close()

	_, err := pubsub.Receive(ctx)
	if err != nil {
		log.Printf("Falha ao inscrever no canal %s: %v", channel, err)
		return
	}
	log.Printf("Worker inscrito no canal de comandos: %s", channel)

	ch := pubsub.Channel()
	for msg := range ch {
		var cmd RecordingCommand
		if err := json.Unmarshal([]byte(msg.Payload), &cmd); err != nil {
			log.Printf("Comando inválido recebido: %v", err)
			continue
		}
		handleRecordingCommand(ctx, cmd, apiURL, serviceToken)
	}
}

func handleRecordingCommand(ctx context.Context, cmd RecordingCommand, apiURL, serviceToken string) {
	if cmd.CameraID == "" {
		return
	}
	switch strings.ToLower(cmd.Action) {
	case "start":
		cam, err := fetchCameraByID(ctx, apiURL, serviceToken, cmd.CameraID)
		if err != nil {
			log.Printf("START: não foi possível carregar câmera %s: %v", cmd.CameraID, err)
			return
		}
		mu.Lock()
		if cmd.SegmentSeconds > 0 {
			recordingSegments[cam.ID] = cmd.SegmentSeconds
		}
		if !activeRecordings[cam.ID] {
			log.Printf("[%s] START recebido via comando Redis", cam.Name)
			startRecordingLocked(ctx, *cam, apiURL, serviceToken)
		}
		mu.Unlock()
	case "stop":
		mu.Lock()
		if activeRecordings[cmd.CameraID] {
			stopRecordingLocked(cmd.CameraID)
			log.Printf("[%s] STOP recebido via comando Redis", cmd.CameraID)
		}
		mu.Unlock()
	default:
		log.Printf("Ação desconhecida no comando: %s", cmd.Action)
	}
}

func processCamera(ctx context.Context, cam Camera, secretKey, apiURL, serviceToken string) {
	password, err := decrypt(cam.PasswordEncrypted, secretKey)
	if err != nil {
		log.Printf("[%s] Erro ao descriptografar: %v", cam.Name, err)
		return
	}

	rtspURL := buildRtspURL(cam, password)
	if checkCameraRTSP(ctx, rtspURL) {
		fmt.Printf("[%s] ONLINE\n", cam.Name)
		reportStatus(apiURL, serviceToken, cam.ID, "ONLINE")
	} else {
		fmt.Printf("[%s] OFFLINE\n", cam.Name)
		reportStatus(apiURL, serviceToken, cam.ID, "OFFLINE")
	}
}

func reportStatus(apiURL, serviceToken, cameraID, status string) {
	url := fmt.Sprintf("%s/cameras/internal/%s/status", apiURL, cameraID)
	payload := map[string]string{"status": status}
	jsonPayload, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonPayload))
	if err != nil {
		log.Printf("[%s] Erro ao criar request de status: %v", cameraID, err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Service-Token", serviceToken)

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[%s] Falha ao reportar status: %v", cameraID, err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		log.Printf("[%s] Erro na API ao reportar status: %d", cameraID, resp.StatusCode)
	}
}

func decrypt(payload, secret string) (string, error) {
	return _decryptWithKey(payload, secret)
}

func _decryptWithKey(payload, secret string) (string, error) {
	key := sha256.Sum256([]byte(secret))

	data, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return "", err
	}

	if len(data) < 28 { // 12 (IV) + 16 (Tag)
		return "", fmt.Errorf("payload muito curto")
	}

	iv := data[:12]
	tag := data[12:28]
	ciphertext := data[28:]

	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}

	aesgcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	ciphertextWithTag := append(ciphertext, tag...)
	plaintext, err := aesgcm.Open(nil, iv, ciphertextWithTag, nil)
	if err != nil {
		return "", err
	}

	return string(plaintext), nil
}

func buildRtspURL(cam Camera, password string) string {
	// rtsp://username:password@ip:port/path
	// Simplificado para o exemplo, em produção tratar caracteres especiais
	recordingChannel := cam.Channel
	if cam.RecordingChannel != nil && *cam.RecordingChannel > 0 {
		recordingChannel = *cam.RecordingChannel
	}
	recordingSubtype := cam.Subtype
	if cam.RecordingSubtype != nil && *cam.RecordingSubtype >= 0 {
		recordingSubtype = *cam.RecordingSubtype
	}
	path := cam.RtspPath
	if path == "" {
		path = fmt.Sprintf("Streaming/Channels/%d%02d", recordingChannel, recordingSubtype)
	}
	path = strings.ReplaceAll(path, fmt.Sprintf("channel=%d", cam.Channel), fmt.Sprintf("channel=%d", recordingChannel))
	path = strings.ReplaceAll(path, fmt.Sprintf("subtype=%d", cam.Subtype), fmt.Sprintf("subtype=%d", recordingSubtype))
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return fmt.Sprintf("rtsp://%s:%s@%s:%d%s", cam.Username, password, cam.IP, cam.RtspPort, path)
}

func checkCameraRTSP(parent context.Context, rtspURL string) bool {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()

	cmd, cleanup, err := secretURLCommand(
		ctx,
		"ffmpeg",
		[]string{
			"-rtsp_transport", "tcp",
			"-i", rtspURL,
			"-frames:v", "1",
			"-f", "null",
			"-",
		},
		rtspURL,
	)
	if err != nil {
		return false
	}
	defer cleanup()

	// Capturar saída para debug se necessário
	var stderr io.Writer
	cmd.Stderr = stderr

	return cmd.Run() == nil
}
