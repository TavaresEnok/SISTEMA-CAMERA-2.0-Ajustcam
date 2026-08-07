"""Cruzamento de linha virtual (tripwire) com IA local.

A OPÇÃO B: a linha é desenhada no DRAC e a travessia é decidida aqui, sobre
objetos que o YOLO detectou e o rastreador manteve identificados entre quadros.
Funciona em QUALQUER câmera — inclusive nas que não têm IVS no próprio chip.

Três decisões que definem se isto é usável ou vira alarme falso:

1. **Só objeto, nunca movimento cru.** Um galho balançando cruza a linha; uma
   sombra cruza; chuva cruza. Nesta frota, 7 dias renderam 208.912 eventos de
   movimento contra 4.422 com pessoa ou veículo de verdade. Tripwire sobre
   movimento seria inútil na primeira madrugada de vento.

2. **Rastreamento é obrigatório.** Sem identidade entre quadros não existe
   trajeto, e sem trajeto não há cruzamento — só se saberia que "há alguém de
   cada lado", que é outra pergunta. O ByteTrack já existe no object_detector;
   aqui só guardamos a última posição de cada `trackId`.

3. **O ponto de referência é a BASE da caixa.** Uma pessoa é alta: pelo centro,
   ela "cruza" a linha do chão com o tronco enquanto os pés ainda estão fora.
   A base é onde o objeto toca o solo — é o que corresponde à linha que o
   operador desenhou no piso.

A geometria é gêmea de `apps/api/src/cameras/helpers/cruzamento-de-linha.helper.ts`;
os testes de lá cobrem os mesmos casos-limite (linha tem fim, colinear não
conta, objeto parado não cruza).
"""

from __future__ import annotations

import math
import time
from typing import Any, Dict, Iterable, List, Optional, Tuple

# Depois deste tempo sem ver um trackId, sua última posição é esquecida.
# Reaproveitar posição velha faria um objeto "saltar" o quadro inteiro e cruzar
# tudo no caminho — o modo mais fácil de gerar alarme falso em massa.
TTL_RASTRO_S = 5.0

# Teto de rastros guardados por câmera: cena movimentada com IDs trocando não
# pode virar vazamento de memória num processo que também atende vídeo.
MAX_RASTROS = 128


def _lado(ax: float, ay: float, bx: float, by: float, px: float, py: float) -> float:
    """Produto vetorial: sinal diz de que lado da reta AB o ponto P está."""
    return (bx - ax) * (py - ay) - (by - ay) * (px - ax)


def _sinal(v: float, eps: float = 1e-9) -> int:
    return 1 if v > eps else (-1 if v < -eps else 0)


def _segmentos_cruzam(
    p: Tuple[float, float], q: Tuple[float, float],
    a: Tuple[float, float], b: Tuple[float, float],
) -> bool:
    """Os segmentos P→Q e A→B se cruzam de fato?

    Trocar de lado NÃO basta: quem anda longe da linha, mas do outro lado do
    plano, também troca de sinal. É preciso que cada segmento separe os
    extremos do outro — senão a linha vira reta infinita e dispara com o objeto
    a metros do portão.
    """
    d1 = _sinal(_lado(a[0], a[1], b[0], b[1], p[0], p[1]))
    d2 = _sinal(_lado(a[0], a[1], b[0], b[1], q[0], q[1]))
    d3 = _sinal(_lado(p[0], p[1], q[0], q[1], a[0], a[1]))
    d4 = _sinal(_lado(p[0], p[1], q[0], q[1], b[0], b[1]))
    if d1 == 0 and d2 == 0:
        return False  # trajeto colinear com a linha: roçar não é cruzar
    return d1 != d2 and d3 != d4


def linhas_de(zonas: Optional[Iterable[Any]]) -> List[Dict[str, Any]]:
    """Extrai só as zonas do tipo linha, já validadas (2 pontos distintos)."""
    saida: List[Dict[str, Any]] = []
    if not zonas:
        return saida
    for z in zonas:
        if not isinstance(z, dict) or z.get("kind") != "line":
            continue
        pontos = z.get("points")
        if not isinstance(pontos, list) or len(pontos) != 2:
            continue
        try:
            ax, ay = float(pontos[0][0]), float(pontos[0][1])
            bx, by = float(pontos[1][0]), float(pontos[1][1])
        except (TypeError, ValueError, IndexError):
            continue
        if not all(math.isfinite(v) for v in (ax, ay, bx, by)):
            continue
        if math.hypot(bx - ax, by - ay) <= 1e-6:
            continue
        sentido = z.get("sentido")
        saida.append({
            "id": str(z.get("id") or ""),
            "name": str(z.get("name") or "Linha"),
            "a": (ax, ay),
            "b": (bx, by),
            "sentido": sentido if sentido in ("ambos", "ab", "ba") else "ambos",
        })
    return saida


def ponto_de_referencia(bbox: Any, largura: int, altura: int) -> Optional[Tuple[float, float]]:
    """Meio da BASE da caixa, em coordenadas normalizadas (0..1)."""
    if not bbox or len(bbox) < 4 or largura <= 0 or altura <= 0:
        return None
    try:
        x1, y1, x2, y2 = (float(v) for v in bbox[:4])
    except (TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x1, y1, x2, y2)):
        return None
    return ((x1 + x2) / 2.0 / largura, max(y1, y2) / altura)


class DetectorDeTravessia:
    """Guarda o rastro de cada objeto e decide travessias por câmera."""

    def __init__(self, zonas: Optional[Iterable[Any]] = None) -> None:
        self.linhas = linhas_de(zonas)
        # trackId -> (x, y, visto_em)
        self._rastros: Dict[str, Tuple[float, float, float]] = {}

    @property
    def ativo(self) -> bool:
        """Sem linha configurada não há trabalho a fazer — nem custo."""
        return bool(self.linhas)

    def atualizar_zonas(self, zonas: Optional[Iterable[Any]]) -> None:
        self.linhas = linhas_de(zonas)
        if not self.linhas:
            self._rastros.clear()

    def _podar(self, agora: float) -> None:
        """Esquece rastro parado há tempo demais (TTL)."""
        vencidos = [k for k, (_, _, t) in self._rastros.items() if agora - t > TTL_RASTRO_S]
        for k in vencidos:
            self._rastros.pop(k, None)

    def _limitar(self) -> None:
        """Aplica o teto de memória, descartando os mais antigos.

        Roda DEPOIS de inserir os rastros do quadro, não antes: podar primeiro
        deixava o dicionário passar do teto por tudo que acabara de entrar.
        """
        excedente = len(self._rastros) - MAX_RASTROS
        if excedente <= 0:
            return
        for k, _ in sorted(self._rastros.items(), key=lambda kv: kv[1][2])[:excedente]:
            self._rastros.pop(k, None)

    def avaliar(
        self,
        deteccoes: Iterable[Any],
        largura: int,
        altura: int,
        agora: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        """Processa as detecções de UM quadro e devolve as travessias.

        Espera detecções com `bbox`, `label` e um id de rastreamento em
        `extra['trackId']`. Detecção SEM trackId é ignorada de propósito: sem
        identidade não há trajeto, e inventar um casamento por proximidade
        seria reimplementar (mal) o rastreador que já existe.
        """
        if not self.linhas:
            return []
        agora = time.time() if agora is None else agora
        self._podar(agora)

        travessias: List[Dict[str, Any]] = []
        for det in deteccoes or []:
            extra = getattr(det, "extra", None) or {}
            track_id = extra.get("trackId") or extra.get("rawTrackId")
            if track_id is None:
                continue
            chave = f"{getattr(det, 'label', '?')}:{track_id}"

            atual = ponto_de_referencia(getattr(det, "bbox", None), largura, altura)
            if atual is None:
                continue

            anterior = self._rastros.get(chave)
            self._rastros[chave] = (atual[0], atual[1], agora)
            if anterior is None:
                continue  # primeira vez que vemos este objeto: sem trajeto ainda

            px, py, _ = anterior
            if math.hypot(atual[0] - px, atual[1] - py) < 1e-6:
                continue  # parado não cruza

            for linha in self.linhas:
                if not _segmentos_cruzam((px, py), atual, linha["a"], linha["b"]):
                    continue
                lado_antes = _sinal(_lado(*linha["a"], *linha["b"], px, py))
                sentido = "ab" if lado_antes < 0 else "ba"
                configurado = linha["sentido"]
                travessias.append({
                    "linhaId": linha["id"],
                    "linhaNome": linha["name"],
                    "sentido": sentido,
                    "proibido": configurado in ("ambos", sentido),
                    "label": getattr(det, "label", None),
                    "confidence": getattr(det, "confidence", None),
                    "trackId": str(track_id),
                })
        self._limitar()
        return travessias
