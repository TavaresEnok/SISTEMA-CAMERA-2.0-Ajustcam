package main

import "testing"

// A API e este worker gravam as MESMAS câmeras. A exclusividade entre os dois
// existia só do lado da API (`RecordingProcessManagerService.start()` desvia por
// RECORDING_CONTROL_MODE e, em modo `worker`, não sobe ffmpeg). O worker nunca
// leu essa variável: o laço de 60s dele grava toda câmera com
// recordingEnabled=true, sem consultar Redis nem a API.
//
// Com o default do env (`local`), subir o profile legacy-worker fazia os dois
// gravarem em paralelo — dobro de CPU e disco, linhas duplicadas e duas sessões
// RTSP na mesma câmera. Não dependia de "vários workers": bastava UM, na
// configuração padrão.
//
// O que estes testes travam: a recusa acontece por REGRA, não por aviso no log.

func TestControlModeAceitaApenasWorker(t *testing.T) {
	if reason := controlModeRefusal("worker"); reason != "" {
		t.Fatalf("modo worker deveria ser aceito, recusou: %s", reason)
	}
	// Tolerância a espaço/caixa: o valor vem de compose/env de operador.
	if reason := controlModeRefusal("  WORKER  "); reason != "" {
		t.Fatalf("modo worker com espaço/maiúscula deveria ser aceito, recusou: %s", reason)
	}
}

func TestControlModeVazioRecusaEExplicaODefault(t *testing.T) {
	reason := controlModeRefusal("")
	if reason == "" {
		t.Fatal("variável ausente PRECISA recusar: é exatamente a configuração padrão que duplicava a gravação")
	}
	// A mensagem tem que dizer o que fazer — quem lê está com o container em
	// crash loop e precisa da saída, não só do diagnóstico.
	if !contains(reason, "RECORDING_CONTROL_MODE=worker") {
		t.Fatalf("a recusa deve indicar a correção, veio: %s", reason)
	}
}

func TestControlModeLocalRecusa(t *testing.T) {
	reason := controlModeRefusal("local")
	if reason == "" {
		t.Fatal("modo local = quem grava é a API; o worker não pode subir junto")
	}
}

func TestControlModeDesconhecidoRecusa(t *testing.T) {
	// Fail-closed: valor que não entendemos não pode virar permissão.
	if reason := controlModeRefusal("qualquer-coisa"); reason == "" {
		t.Fatal("valor desconhecido tem que recusar, não liberar")
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}
