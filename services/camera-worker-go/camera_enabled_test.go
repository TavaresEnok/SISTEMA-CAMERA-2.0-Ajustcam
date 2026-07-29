package main

import (
	"encoding/json"
	"testing"
)

// `Camera.enabled=false` é uma decisão DELIBERADA do operador: cliente
// desligado, câmera em área sensível, pedido de LGPD. A API recusa gravar nesse
// estado (recording-process-manager.service.ts testa `camera.enabled === false`)
// e esconde a câmera de não-admins.
//
// O worker não tinha sequer o campo na struct: gravava e sondava a câmera do
// mesmo jeito. O operador via "desativada" na interface enquanto o disco
// continuava enchendo com ela e uma sessão RTSP seguia aberta no equipamento.

func boolPtr(v bool) *bool { return &v }

func TestCameraDesativadaNaoGravaNemSonda(t *testing.T) {
	cam := Camera{ID: "c1", Enabled: boolPtr(false), RecordingEnabled: true}
	if cameraIsEnabled(cam) {
		t.Fatal("enabled=false tem que contar como desativada")
	}
	if cameraIsRecordable(cam) {
		t.Fatal("câmera desativada não pode gravar, mesmo com recordingEnabled=true")
	}
}

func TestCameraAtivaComGravacaoLigadaGrava(t *testing.T) {
	cam := Camera{ID: "c1", Enabled: boolPtr(true), RecordingEnabled: true}
	if !cameraIsRecordable(cam) {
		t.Fatal("câmera ativa com gravação ligada precisa gravar")
	}
}

func TestCampoAusenteContaComoAtiva(t *testing.T) {
	// FAIL-OPEN deliberado. Se o payload da API deixar de trazer `enabled`, o
	// pior resultado aceitável é seguir gravando como hoje. Tratar ausência como
	// "desativada" pararia a gravação de TODO o parque em silêncio — o modo de
	// falha caro num VMS.
	var cam Camera
	if err := json.Unmarshal([]byte(`{"id":"c1","recordingEnabled":true}`), &cam); err != nil {
		t.Fatalf("json inválido: %v", err)
	}
	if cam.Enabled != nil {
		t.Fatal("campo ausente deveria desserializar como nil")
	}
	if !cameraIsEnabled(cam) {
		t.Fatal("ausência do campo tem que contar como ATIVA (fail-open)")
	}
	if !cameraIsRecordable(cam) {
		t.Fatal("sem o campo, o comportamento tem que ser o de antes: grava")
	}
}

func TestJsonEnabledFalseEhRespeitado(t *testing.T) {
	// O ponteiro existe justamente para distinguir "veio false" de "não veio".
	var cam Camera
	if err := json.Unmarshal([]byte(`{"id":"c1","enabled":false,"recordingEnabled":true}`), &cam); err != nil {
		t.Fatalf("json inválido: %v", err)
	}
	if cam.Enabled == nil || *cam.Enabled {
		t.Fatal("enabled=false explícito precisa chegar como false")
	}
	if cameraIsRecordable(cam) {
		t.Fatal("enabled=false explícito tem que impedir a gravação")
	}
}

func TestGravacaoDesligadaNaoGravaMesmoAtiva(t *testing.T) {
	cam := Camera{ID: "c1", Enabled: boolPtr(true), RecordingEnabled: false}
	if cameraIsRecordable(cam) {
		t.Fatal("recordingEnabled=false continua impedindo a gravação")
	}
	if !cameraIsEnabled(cam) {
		t.Fatal("mas a câmera segue ATIVA — ela ainda pode ser sondada/exibida")
	}
}
