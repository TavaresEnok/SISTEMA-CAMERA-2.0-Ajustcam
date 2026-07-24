"""Redação de credencial + logging do StreamProcessor (item 4.4).

Importar stream_processor puxa cv2 (e requests) → no host (sem cv2) estes testes
são PULADOS; rodam no container ML (drac-ai-test-ml). Construir um StreamProcessor
é barato: __init__ só lê env e cria um MotionDetector (nenhuma thread/rede).

O teste-âncora prova o invariante 1.2.v: a URL RTSP nunca é logada crua — o
_sanitize_url remove o par user:senha. Mutar _sanitize_url para devolver a URL
crua deixa este teste VERMELHO (dente).
"""

import logging
import unittest

try:
    import cv2  # noqa: F401
    from stream_processor import StreamProcessor

    HAS_STREAM = True
except Exception:
    HAS_STREAM = False


@unittest.skipUnless(HAS_STREAM, "requer cv2 + requests (importa stream_processor) — container ML")
class TestSanitizeUrl(unittest.TestCase):
    def _proc(self, url="rtsp://user:s3cr3t@cam.local:554/stream1"):
        return StreamProcessor("cam-1", url, "http://api:3000", "tok", "motion")

    def test_redige_usuario_e_senha(self):
        proc = self._proc()
        safe = proc._sanitize_url(proc.rtsp_url)
        self.assertNotIn("s3cr3t", safe)
        self.assertNotIn("user", safe)
        self.assertIn("<redacted>@cam.local:554", safe)
        self.assertIn("/stream1", safe)

    def test_url_sem_credencial_passa_intacta(self):
        proc = self._proc(url="rtsp://cam.local:554/stream1")
        safe = proc._sanitize_url(proc.rtsp_url)
        self.assertEqual(safe, "rtsp://cam.local:554/stream1")

    def test_entrada_invalida_vira_placeholder_fail_safe(self):
        proc = self._proc()
        # Invariante fail-safe: QUALQUER entrada que quebre o parsing deve virar o
        # placeholder redigido — nunca vazar. Uma entrada não-str dispara o ramo de
        # exceção interno (urlsplit devolve bytes → o teste `"@" in netloc` levanta),
        # que o try/except captura e devolve o placeholder seguro.
        self.assertEqual(proc._sanitize_url(None), "<rtsp-url-redacted>")


@unittest.skipUnless(HAS_STREAM, "requer cv2 + requests — container ML")
class TestStreamLogging(unittest.TestCase):
    def test_modulo_expoe_logger(self):
        import stream_processor

        self.assertIsInstance(stream_processor.logger, logging.Logger)
        self.assertEqual(stream_processor.logger.name, "ai-service.stream")

    def test_report_event_loga_sem_vazar_url(self):
        # _report_event loga o evento; a URL da câmera NUNCA deve aparecer no log.
        proc = StreamProcessor(
            "cam-secret",
            "rtsp://admin:topsecret@cam.local:554/stream1",
            "http://api:3000",
            "tok",
            "motion",
        )
        with self.assertLogs("ai-service.stream", level="INFO") as captured:
            # A chamada de rede vai falhar (host inexistente) e ser logada como
            # warning — o que importa é que nenhuma linha contenha a senha.
            proc._report_event("MOTION_DETECTED", 0.9, "pessoa (0.90)", {"value": 0.9})
        joined = "\n".join(captured.output)
        self.assertNotIn("topsecret", joined)
        self.assertIn("cam-secret", joined)


if __name__ == "__main__":
    unittest.main()
