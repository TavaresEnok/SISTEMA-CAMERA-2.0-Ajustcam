"""`StreamProcessor.inference_state()` — o watchdog de inferência no processador real.

Importar stream_processor puxa cv2 (e requests) → no host estes testes são
PULADOS; rodam no container ML (run-ml-tests.sh). Construir um StreamProcessor é
barato: __init__ só lê env e cria o MotionDetector (nenhuma thread/rede).

O que estes testes travam, com o objeto REAL (nada de fake do processador):
  • processador em modo 'motion' (a produção de hoje, IA de objeto DESLIGADA) →
    `not_applicable`, jamais degradado;
  • processador em modo 'general' com captura viva e ZERO inferência além do
    warmup → degradado (é o modelo que não carregou e matou a thread);
  • depois de uma inferência registrada, volta a `ok`;
  • sem captura pronta, o veredito é da captura — não da inferência.
"""

import time
import unittest

try:
    import cv2  # noqa: F401
    from stream_processor import StreamProcessor

    HAS_STREAM = True
except Exception:
    HAS_STREAM = False

from inference_watchdog import (
    STATUS_CAPTURE_NOT_READY,
    STATUS_IDLE,
    STATUS_NOT_APPLICABLE,
    STATUS_OK,
    STATUS_STALLED,
    STATUS_WARMING_UP,
)


@unittest.skipUnless(HAS_STREAM, "requer cv2 + requests (importa stream_processor) — container ML")
class TestInferenceState(unittest.TestCase):
    def _proc(self, analysis_type="motion"):
        proc = StreamProcessor(
            "cam-1",
            "rtsp://user:s3cr3t@cam.local:554/stream1",
            "http://api:3000",
            "tok",
            analysis_type,
        )
        return proc

    def _com_captura_viva(self, proc, age_seconds=1200.0):
        """Estado real de 'captura viva': rodando, frame recente, sem falhas."""
        proc.running = True
        proc.last_seen = time.time()
        proc._started_at = time.time() - age_seconds
        return proc

    def test_modo_motion_e_not_applicable(self):
        proc = self._com_captura_viva(self._proc("motion"))
        state = proc.inference_state()
        self.assertEqual(state["status"], STATUS_NOT_APPLICABLE)
        self.assertFalse(state["degraded"])
        self.assertIsNone(state["detector_type"])

    def test_general_sem_nenhuma_inferencia_fica_degradado(self):
        proc = self._com_captura_viva(self._proc("general"))
        state = proc.inference_state()
        self.assertTrue(state["degraded"])
        self.assertEqual(state["status"], STATUS_STALLED)
        self.assertEqual(state["reason"], "no_inference_since_start")
        self.assertEqual(state["detector_type"], "general")

    def test_general_recem_iniciado_esta_em_warmup(self):
        proc = self._com_captura_viva(self._proc("general"), age_seconds=2.0)
        state = proc.inference_state()
        self.assertFalse(state["degraded"])
        self.assertEqual(state["status"], STATUS_WARMING_UP)

    def test_general_com_inferencia_recente_esta_ok(self):
        proc = self._com_captura_viva(self._proc("general"))
        # Exatamente o que o _process() registra ao inferir com sucesso.
        proc.advanced_infer_runs += 1
        proc._inference_timestamps.append(time.time())
        proc.advanced_infer_sum_ms += 40.0
        proc.advanced_infer_last_ms = 40.0
        state = proc.inference_state()
        self.assertEqual(state["status"], STATUS_OK)
        self.assertFalse(state["degraded"])
        self.assertEqual(state["runs"], 1)
        self.assertEqual(state["last_duration_ms"], 40.0)
        self.assertEqual(state["avg_duration_ms"], 40.0)

    def test_general_que_inferiu_e_parou_fica_degradado(self):
        proc = self._com_captura_viva(self._proc("general"))
        proc.advanced_infer_runs += 1
        proc._inference_timestamps.append(time.time() - 900.0)
        state = proc.inference_state()
        self.assertTrue(state["degraded"])
        self.assertEqual(state["reason"], "inference_stalled")

    def test_captura_parada_nao_vira_inferencia_travada(self):
        proc = self._proc("general")  # nunca iniciado: readiness reprova
        state = proc.inference_state()
        self.assertFalse(state["degraded"])
        self.assertEqual(state["status"], STATUS_CAPTURE_NOT_READY)

    def test_captura_pronta_pode_ser_injetada_pelo_health(self):
        proc = self._proc("general")
        proc._started_at = time.time() - 1200.0
        state = proc.inference_state(capture_ready=True)
        self.assertTrue(state["degraded"])

    def test_camera_hibernando_nao_e_degradada(self):
        # perfil 'face' nasce com motion_trigger=CAMERA: dormindo até o ONVIF.
        proc = self._com_captura_viva(self._proc("face"))
        self.assertEqual(proc.motion_trigger, "CAMERA")
        proc.wakeup_until = 0
        state = proc.inference_state(capture_ready=True)
        self.assertFalse(state["degraded"])
        self.assertEqual(state["status"], STATUS_IDLE)

    def test_intervalo_esperado_acompanha_o_fps_avancado(self):
        proc = self._com_captura_viva(self._proc("general"))
        proc.advanced_process_fps = 4.0
        state = proc.inference_state(capture_ready=True)
        self.assertAlmostEqual(state["expected_interval_seconds"], 0.25, places=4)

    def test_health_do_processador_nao_muda_o_caminho_de_movimento(self):
        # inference_state é OBSERVAÇÃO: não pode mexer em contador algum.
        proc = self._com_captura_viva(self._proc("motion"))
        before = (
            proc.advanced_infer_runs,
            proc.advanced_infer_errors,
            proc.processed_frames,
            proc.wakeup_until,
            len(proc._inference_timestamps),
        )
        proc.inference_state()
        proc.inference_state()
        after = (
            proc.advanced_infer_runs,
            proc.advanced_infer_errors,
            proc.processed_frames,
            proc.wakeup_until,
            len(proc._inference_timestamps),
        )
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
