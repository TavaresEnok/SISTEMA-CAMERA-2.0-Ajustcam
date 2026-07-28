"""Caminho rápido da normalização de contraste do detector de movimento.

Medido em 2026-07-27, a normalização respondia por ~52% do custo por frame —
mais que o próprio MOG2. O gargalo era a FORMA, não a ideia:

  * `np.percentile` ORDENA o array inteiro (57.600 elementos a 320×180) só para
    devolver dois números, duas vezes por frame;
  * o esticamento alocava buffers float32 do tamanho do frame para aplicar uma
    função que, com entrada uint8, tem apenas 256 respostas possíveis.

As duas funções aqui são substitutas BIT-EXATAS, não aproximações. Isso é
requisito, não capricho: o resultado alimenta a média móvel de 50 frames e daí
o limiar de movimento de TODAS as câmeras. Um caminho rápido que divergisse por
um nível mudaria a sensibilidade do sistema inteiro sem uma linha de log — e o
sintoma ("parou de detectar direito") apareceria meses depois, longe da causa.

`tests/test_motion_contrast_fastpath.py` trava a equivalência contra a
implementação antiga, inclusive em frames minúsculos (onde a interpolação do
percentil de fato pesa) e nos 256 valores de entrada por construção.
"""

from __future__ import annotations

import cv2
import numpy as np

# Domínio completo de um uint8 — o esticamento é uma função pura sobre ele.
_DOMAIN_U8 = np.arange(256).astype(np.float32)


def uint8_percentile(gray: np.ndarray, q: float) -> float:
    """Percentil de um array uint8 via histograma, com a MESMA interpolação do NumPy.

    `np.percentile(..., method='linear')` interpola linearmente entre as duas
    estatísticas de ordem que cercam o posto `(n-1) * q/100`. Um histograma
    ingênuo devolveria o posto MAIS PRÓXIMO (sempre um inteiro) — o que casa em
    frame grande, onde os dois vizinhos quase sempre são o mesmo valor, e
    diverge justamente onde há poucos pixels. Aqui as duas estatísticas de ordem
    são extraídas do histograma acumulado e interpoladas explicitamente.

    Custo: O(n) para contar + O(256) para acumular, contra O(n log n) da ordenação.
    """
    flat = gray.ravel()
    n = flat.size
    if n == 0:
        raise ValueError("percentil de array vazio")
    if n == 1:
        return float(flat[0])

    counts = np.bincount(flat, minlength=256)
    cumulative = np.cumsum(counts)

    rank = (n - 1) * (q / 100.0)
    lower_index = int(np.floor(rank))
    frac = rank - lower_index

    # k-ésima estatística de ordem (0-based) = menor valor v com cumulative[v] > k.
    lower_value = float(np.searchsorted(cumulative, lower_index, side="right"))
    if frac == 0.0:
        return lower_value
    upper_value = float(np.searchsorted(cumulative, min(lower_index + 1, n - 1), side="right"))
    return lower_value + frac * (upper_value - lower_value)


def stretch_lut(frame: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """Estica o histograma de `frame` para [0, 255] usando uma LUT de 256 entradas.

    Reproduz `(clip(f32, lo, hi) - lo) * (255 / (hi - lo))` seguido de
    `astype(uint8)`. O `astype` TRUNCA (não arredonda) — por isso a LUT é
    montada com as mesmas operações em float32 e o mesmo `astype`, e não com
    `cv2.convertScaleAbs`, que arredondaria e divergiria em metade dos níveis.

    Custo: 256 operações para montar a tabela + uma passada SIMD do `cv2.LUT`,
    contra dois ou três buffers float32 do tamanho do frame.
    """
    lut = ((np.clip(_DOMAIN_U8, lo, hi) - lo) * (255.0 / (hi - lo))).astype(np.uint8)
    return cv2.LUT(frame, lut)
