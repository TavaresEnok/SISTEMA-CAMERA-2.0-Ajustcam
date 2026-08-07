"""Testes do tripwire com IA local (opção B).

Rodam SEM cv2 e SEM modelo: o detector de travessia é geometria pura sobre
detecções já rastreadas. É de propósito — a peça onde um erro vira alarme falso
às 3h da manhã, ou perímetro cego, precisa poder ser provada sem câmera.

Espelham os casos de `apps/api/tests/cruzamento-de-linha.test.ts`: as duas
implementações têm de concordar, senão o operador vê comportamento diferente ao
trocar a fonte de detecção entre a câmera e a IA local.
"""
import time
import unittest

from detectors.tripwire import DetectorDeTravessia, linhas_de, ponto_de_referencia


class Deteccao:
    """Detecção mínima, no formato que o object_detector emite."""

    def __init__(self, bbox, label="person", confidence=0.9, track_id="t1"):
        self.bbox = bbox
        self.label = label
        self.confidence = confidence
        self.extra = {"trackId": track_id} if track_id is not None else {}


# Linha vertical no meio do quadro (640x360): de (0.5, 0.2) a (0.5, 0.8).
LINHA_VERTICAL = [{
    "id": "l1", "name": "Portão", "kind": "line",
    "points": [[0.5, 0.2], [0.5, 0.8]],
}]
L, A = 640, 360


def caixa_em(x_norm, y_norm, larg=0.1, alt=0.2):
    """Caixa cuja BASE fica em (x_norm, y_norm)."""
    x1 = (x_norm - larg / 2) * L
    x2 = (x_norm + larg / 2) * L
    y2 = y_norm * A
    y1 = y2 - alt * A
    return [x1, y1, x2, y2]


class TravessiaTests(unittest.TestCase):
    def test_atravessar_dispara_e_andar_do_mesmo_lado_nao(self):
        d = DetectorDeTravessia(LINHA_VERTICAL)
        agora = 1000.0
        # Primeiro quadro: só registra o rastro, ainda não há trajeto.
        self.assertEqual(d.avaliar([Deteccao(caixa_em(0.3, 0.5))], L, A, agora), [])
        # Segundo quadro: atravessou.
        t = d.avaliar([Deteccao(caixa_em(0.7, 0.5))], L, A, agora + 0.5)
        self.assertEqual(len(t), 1)
        self.assertEqual(t[0]["linhaNome"], "Portão")
        self.assertEqual(t[0]["label"], "person")

        # Continua andando do mesmo lado: não dispara de novo.
        self.assertEqual(d.avaliar([Deteccao(caixa_em(0.9, 0.5))], L, A, agora + 1.0), [])

    def test_a_linha_tem_fim(self):
        # O erro clássico: tratar a linha como reta infinita. A linha vai de
        # y=0.2 a y=0.8; quem cruza o mesmo x em y=0.05 passa POR CIMA do
        # portão. Sem isto, uma linha no portão dispara com gente na calçada.
        d = DetectorDeTravessia(LINHA_VERTICAL)
        d.avaliar([Deteccao(caixa_em(0.3, 0.05))], L, A, 1000.0)
        self.assertEqual(d.avaliar([Deteccao(caixa_em(0.7, 0.05))], L, A, 1000.5), [])

    def test_sentido_e_oposto_na_volta(self):
        ida = DetectorDeTravessia(LINHA_VERTICAL)
        ida.avaliar([Deteccao(caixa_em(0.3, 0.5))], L, A, 1000.0)
        t_ida = ida.avaliar([Deteccao(caixa_em(0.7, 0.5))], L, A, 1000.5)

        volta = DetectorDeTravessia(LINHA_VERTICAL)
        volta.avaliar([Deteccao(caixa_em(0.7, 0.5))], L, A, 1000.0)
        t_volta = volta.avaliar([Deteccao(caixa_em(0.3, 0.5))], L, A, 1000.5)

        self.assertNotEqual(t_ida[0]["sentido"], t_volta[0]["sentido"])

    def test_sentido_configurado_marca_so_a_direcao_proibida(self):
        ida = DetectorDeTravessia(LINHA_VERTICAL)
        ida.avaliar([Deteccao(caixa_em(0.3, 0.5))], L, A, 1000.0)
        sentido_entrando = ida.avaliar([Deteccao(caixa_em(0.7, 0.5))], L, A, 1000.5)[0]["sentido"]

        linha = [dict(LINHA_VERTICAL[0], sentido=sentido_entrando)]

        entrando = DetectorDeTravessia(linha)
        entrando.avaliar([Deteccao(caixa_em(0.3, 0.5))], L, A, 1000.0)
        t1 = entrando.avaliar([Deteccao(caixa_em(0.7, 0.5))], L, A, 1000.5)
        self.assertTrue(t1[0]["proibido"])

        saindo = DetectorDeTravessia(linha)
        saindo.avaliar([Deteccao(caixa_em(0.7, 0.5))], L, A, 1000.0)
        t2 = saindo.avaliar([Deteccao(caixa_em(0.3, 0.5))], L, A, 1000.5)
        self.assertEqual(len(t2), 1, "a travessia ainda deve ser RELATADA")
        self.assertFalse(t2[0]["proibido"], "sair virou infração")

    def test_deteccao_sem_rastreamento_e_ignorada(self):
        # Sem identidade entre quadros não há trajeto. Casar por proximidade
        # seria reimplementar (mal) o rastreador que já existe.
        d = DetectorDeTravessia(LINHA_VERTICAL)
        d.avaliar([Deteccao(caixa_em(0.3, 0.5), track_id=None)], L, A, 1000.0)
        self.assertEqual(d.avaliar([Deteccao(caixa_em(0.7, 0.5), track_id=None)], L, A, 1000.5), [])

    def test_objetos_diferentes_nao_compartilham_rastro(self):
        # Duas pessoas em lados opostos: se os rastros se misturassem, uma
        # "teleportaria" para o lugar da outra e cruzaria a linha sozinha.
        d = DetectorDeTravessia(LINHA_VERTICAL)
        d.avaliar([
            Deteccao(caixa_em(0.3, 0.5), track_id="A"),
            Deteccao(caixa_em(0.7, 0.5), track_id="B"),
        ], L, A, 1000.0)
        t = d.avaliar([
            Deteccao(caixa_em(0.32, 0.5), track_id="A"),
            Deteccao(caixa_em(0.72, 0.5), track_id="B"),
        ], L, A, 1000.5)
        self.assertEqual(t, [], "rastros se misturaram")

    def test_rastro_velho_e_esquecido(self):
        # Reaproveitar posição antiga faria o objeto "saltar" o quadro inteiro
        # e cruzar tudo no caminho — alarme falso em massa.
        d = DetectorDeTravessia(LINHA_VERTICAL)
        d.avaliar([Deteccao(caixa_em(0.3, 0.5))], L, A, 1000.0)
        muito_depois = 1000.0 + 60.0
        self.assertEqual(d.avaliar([Deteccao(caixa_em(0.7, 0.5))], L, A, muito_depois), [])

    def test_ponto_de_referencia_e_a_base_da_caixa(self):
        # Pessoa alta: pelo centro ela "cruza" a linha do chão com o tronco
        # enquanto os pés ainda estão fora.
        p = ponto_de_referencia([0.4 * L, 0.2 * A, 0.6 * L, 0.9 * A], L, A)
        self.assertAlmostEqual(p[0], 0.5, places=5)
        self.assertAlmostEqual(p[1], 0.9, places=5, msg="não usou a base")

    def test_sem_linha_configurada_o_detector_fica_inativo(self):
        d = DetectorDeTravessia([{"id": "z", "kind": "exclude", "points": [[0, 0], [1, 0], [1, 1]]}])
        self.assertFalse(d.ativo, "polígono virou linha")
        self.assertEqual(d.avaliar([Deteccao(caixa_em(0.7, 0.5))], L, A), [])

    def test_linhas_invalidas_sao_descartadas(self):
        ruins = [
            {"id": "a", "kind": "line", "points": []},
            {"id": "b", "kind": "line", "points": [[0.5, 0.5]]},
            {"id": "c", "kind": "line", "points": [[0.5, 0.5], [0.5, 0.5]]},
            {"id": "d", "kind": "line", "points": [[0.5, "x"], [0.5, 0.8]]},
            {"id": "e", "kind": "line", "points": [[0.5, float("nan")], [0.5, 0.8]]},
        ]
        self.assertEqual(linhas_de(ruins), [])
        self.assertEqual(linhas_de(None), [])

    def test_sentido_invalido_cai_no_padrao(self):
        linhas = linhas_de([dict(LINHA_VERTICAL[0], sentido="diagonal")])
        self.assertEqual(linhas[0]["sentido"], "ambos")

    def test_memoria_nao_cresce_sem_limite(self):
        # Cena movimentada com IDs trocando não pode virar vazamento num
        # processo que também atende vídeo.
        d = DetectorDeTravessia(LINHA_VERTICAL)
        agora = time.time()
        for i in range(400):
            d.avaliar([Deteccao(caixa_em(0.3, 0.5), track_id=f"t{i}")], L, A, agora)
        self.assertLessEqual(len(d._rastros), 128)

    def test_trocar_zonas_em_tempo_de_execucao(self):
        d = DetectorDeTravessia(LINHA_VERTICAL)
        self.assertTrue(d.ativo)
        d.atualizar_zonas([])
        self.assertFalse(d.ativo)
        self.assertEqual(d._rastros, {}, "rastro velho sobreviveu à troca de zona")


if __name__ == "__main__":
    unittest.main()
