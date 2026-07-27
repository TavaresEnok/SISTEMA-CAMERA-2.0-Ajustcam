"""Denuncia FPS de captura ANÔMALO — a assinatura de timestamp quebrado.

Derivado de Frigate (MIT) — Copyright (c) Frigate, Inc.
Técnica original em `frigate/video/ffmpeg.py`: quando o FPS de captura fica em
`detect.fps + 10` por 3 checagens seguidas, o Frigate conclui que os timestamps
da câmera estão quebrados (o decoder para de se cadenciar pelo relógio do stream
e passa a ler o mais rápido que consegue, queimando CPU) e MATA o ffmpeg.

Duas diferenças deliberadas do DRAC:

  1. NÃO derruba nada. O DRAC é VMS com valor probatório: matar a captura por
     suspeita pode custar o instante que o cliente precisava. Aqui o guarda só
     DENUNCIA (evento para o log/health) — quem decide é o operador. O freio de
     CPU (`suggested_sleep_seconds`) é opt-in e nunca é aplicado sozinho.
  2. Exige o excesso SUSTENTADO por tempo (não 3 amostras). Depois de reconectar,
     o buffer drena numa rajada de dezenas de frames — isso é normal e não pode
     virar alarme. Falso positivo que o operador aprende a ignorar destrói o
     valor do alarme verdadeiro.

Módulo PURO (só `collections`/`time`): não importa cv2, então roda e é testado
no host, fora do container de ML. O relógio é injetável para o teste.
"""

import time
from collections import deque

# Frigate usa `detect.fps + 10`; mantemos a mesma margem.
DEFAULT_MARGIN_FPS = 10.0
# Excesso precisa durar isto para virar denúncia (Frigate: 3 checagens ~30s).
DEFAULT_SUSTAIN_SECONDS = 30.0
# Janela sobre a qual a taxa observada é medida.
DEFAULT_WINDOW_SECONDS = 5.0
# Um alarme por câmera a cada 5 min: log de operação, não spam.
DEFAULT_COOLDOWN_SECONDS = 300.0
# Sem amostras suficientes não há evidência — e sem evidência não há alarme.
DEFAULT_MIN_SAMPLES = 12
# Teto de amostras guardadas (memória limitada mesmo a 5.000 fps de spin).
DEFAULT_MAX_SAMPLES = 1024
# FPS assumido quando a câmera não declara o seu (ex.: cap.get(CAP_PROP_FPS)=0).
DEFAULT_FALLBACK_EXPECTED_FPS = 30.0
# FPS declarado acima disto é lixo (câmera mentindo no SDP) e é ignorado.
MAX_PLAUSIBLE_EXPECTED_FPS = 1000.0


def _finite(value):
    """float(value) se for um número finito; None caso contrário (nunca levanta)."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


class CaptureRateGuard:
    """Observa 1 evento por frame CONSUMIDO e acusa taxa muito acima da esperada."""

    def __init__(
        self,
        expected_fps=0.0,
        *,
        margin_fps=DEFAULT_MARGIN_FPS,
        sustain_seconds=DEFAULT_SUSTAIN_SECONDS,
        window_seconds=DEFAULT_WINDOW_SECONDS,
        cooldown_seconds=DEFAULT_COOLDOWN_SECONDS,
        min_samples=DEFAULT_MIN_SAMPLES,
        max_samples=DEFAULT_MAX_SAMPLES,
        fallback_expected_fps=DEFAULT_FALLBACK_EXPECTED_FPS,
        clock=time.time,
    ):
        self._fallback_expected_fps = max(1.0, _finite(fallback_expected_fps) or DEFAULT_FALLBACK_EXPECTED_FPS)
        self._expected_fps = self._fallback_expected_fps
        self._margin_fps = max(1.0, _finite(margin_fps) or DEFAULT_MARGIN_FPS)
        self._sustain_seconds = max(1.0, _finite(sustain_seconds) or DEFAULT_SUSTAIN_SECONDS)
        self._window_seconds = max(1.0, _finite(window_seconds) or DEFAULT_WINDOW_SECONDS)
        self._cooldown_seconds = max(1.0, _finite(cooldown_seconds) or DEFAULT_COOLDOWN_SECONDS)
        self._min_samples = max(2, int(min_samples or DEFAULT_MIN_SAMPLES))
        self._samples = deque(maxlen=max(self._min_samples, int(max_samples or DEFAULT_MAX_SAMPLES)))
        self._clock = clock if callable(clock) else time.time
        self._abnormal_since = None
        self._last_report_at = None
        self._reports = 0
        self._last_observed_fps = 0.0
        self.set_expected_fps(expected_fps)

    # ── configuração ─────────────────────────────────────────────────────────

    @property
    def expected_fps(self):
        return self._expected_fps

    @property
    def threshold_fps(self):
        """Acima disto a taxa é considerada impossível para este stream."""
        return self._expected_fps + self._margin_fps

    def set_expected_fps(self, fps):
        """Aprende o FPS declarado pela fonte. Lixo é IGNORADO (mantém o anterior)."""
        number = _finite(fps)
        if number is None or number <= 0.0 or number > MAX_PLAUSIBLE_EXPECTED_FPS:
            return
        self._expected_fps = number

    # ── medição ──────────────────────────────────────────────────────────────

    def observed_fps(self, now=None):
        """Taxa medida na janela; 0.0 quando não há evidência suficiente."""
        if len(self._samples) < self._min_samples:
            return 0.0
        span = self._samples[-1] - self._samples[0]
        if span <= 0.0:
            return 0.0
        return (len(self._samples) - 1) / span

    def observe(self, now=None):
        """Contabiliza UM frame consumido.

        Devolve o dict do evento quando a anomalia deve ser denunciada AGORA;
        None em qualquer outro caso. Nunca levanta.
        """
        try:
            moment = _finite(self._clock() if now is None else now)
            if moment is None:
                return None

            self._samples.append(moment)
            cutoff = moment - self._window_seconds
            while self._samples and self._samples[0] < cutoff:
                self._samples.popleft()

            rate = self.observed_fps(moment)
            self._last_observed_fps = rate
            threshold = self.threshold_fps

            # Sem evidência (poucas amostras) ou taxa normal → zera o relógio da
            # anomalia. Fail-safe: na dúvida, NÃO alarma.
            if rate <= 0.0 or rate < threshold:
                self._abnormal_since = None
                return None

            if self._abnormal_since is None:
                self._abnormal_since = moment
                return None

            sustained = moment - self._abnormal_since
            if sustained < self._sustain_seconds:
                return None

            if self._last_report_at is not None and (moment - self._last_report_at) < self._cooldown_seconds:
                return None

            self._last_report_at = moment
            self._reports += 1
            return {
                "observed_fps": round(rate, 2),
                "expected_fps": round(self._expected_fps, 2),
                "threshold_fps": round(threshold, 2),
                "sustained_seconds": round(sustained, 1),
                "occurrences": self._reports,
            }
        except Exception:
            # Observabilidade jamais derruba a captura.
            return None

    # ── saídas ───────────────────────────────────────────────────────────────

    def suggested_sleep_seconds(self):
        """Freio SUGERIDO (s por frame) enquanto a anomalia dura; 0.0 se saudável.

        Nunca é aplicado por este módulo — quem chama decide (e no StreamProcessor
        isso é opt-in). O valor cadencia a leitura no LIMITE, não abaixo dele:
        frear mais que isso viraria leitor lento e o MediaMTX derrubaria a sessão.
        """
        if self._abnormal_since is None:
            return 0.0
        return 1.0 / max(1.0, self.threshold_fps)

    def state(self):
        """Diagnóstico para o /health — números, não adjetivos."""
        return {
            "anomalous": self._abnormal_since is not None,
            "observed_fps": round(float(self._last_observed_fps), 2),
            "expected_fps": round(float(self._expected_fps), 2),
            "threshold_fps": round(float(self.threshold_fps), 2),
            "reports": self._reports,
            "last_report_at": self._last_report_at,
        }
