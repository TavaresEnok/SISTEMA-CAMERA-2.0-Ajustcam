"""Backoff exponencial com jitter para reconexão de captura.

Puro (só `random`) — não importa cv2, então é testável sem o opencv instalado.
Substitui o `time.sleep(5)` fixo: uma câmera piscando não gera reconexão em loop
de 5s; e o jitter dessincroniza a reconexão de várias câmeras (evita thundering herd).
"""

import random


def compute_reconnect_delay(attempt, base=1.0, cap=60.0, jitter=0.2):
    """Segundos a esperar antes de reconectar.

    attempt: nº de falhas consecutivas (>=1). Cresce 2^(attempt-1) * base, capado em
    `cap`. jitter (fração) aplica ±jitter multiplicativo. attempt<=0 é tratado como 1.
    """
    n = max(1, int(attempt))
    raw = base * (2 ** (n - 1))
    delay = min(cap, raw)
    if jitter > 0:
        delay = delay * (1.0 + random.uniform(-jitter, jitter))
    return max(0.0, delay)
