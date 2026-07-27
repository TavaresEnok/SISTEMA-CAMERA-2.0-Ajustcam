"""Regiões de inferência derivadas do MOVIMENTO + salto de estacionários.

É o mecanismo que decide se o sistema ENXERGA UMA PESSOA A 40 METROS: rodar o
modelo em 640×640 sobre um frame 1080p inteiro encolhe um alvo de 30 px para
~18 px na entrada — e ele some. Recortando uma região de 320 px em volta do
movimento, o mesmo alvo chega ao modelo com 60 px.

LÓGICA PURA (sem cv2/numpy): roda no host e nos dois containers de teste.
A prova de que o alvo pequeno realmente aparece está em
tests/test_object_detector_regions.py (precisa da stack ML).

Framework: unittest da stdlib (decisão 9.2).
"""

import unittest

from detectors.base import Detection
from detectors.region_proposal import (
    MotionRegionPlanner,
    RegionConfig,
    box_inside,
    boxes_intersect,
    build_regions,
    calculate_region,
    dedupe_by_iou,
    intersection_over_union,
)


FRAME = (1080, 1920)  # (altura, largura) — convenção do cv2/Frigate


def _covers(region, box):
    return box_inside(region, box)


def _inside_frame(region, frame_shape=FRAME):
    x1, y1, x2, y2 = region
    return 0 <= x1 < x2 <= frame_shape[1] and 0 <= y1 < y2 <= frame_shape[0]


def person(bbox, conf=0.8, cls=0):
    return Detection(label="pessoa", confidence=conf, bbox=list(bbox), extra={"classId": cls})


class TestRegionConfigEnv(unittest.TestCase):
    """A flag nasce DESLIGADA e nenhum lixo de env pode desarmar comparação.

    `int("92%")` explode e `float("nan")` NÃO explode — NaN em comparação é
    sempre False e desarma o limite em silêncio (foi o que já mordeu a guarda de
    disco). Aqui lixo sempre cai no default.
    """

    def test_padrao_desligado(self):
        cfg = RegionConfig.from_env({})
        self.assertFalse(cfg.enabled, "a IA de objeto está desligada; isto não pode ligar sozinho")
        self.assertEqual(cfg.min_size, 320)
        self.assertTrue(cfg.stationary_skip)

    def test_liga_por_env(self):
        self.assertTrue(RegionConfig.from_env({"GENERAL_REGION_DETECTION": "true"}).enabled)
        self.assertTrue(RegionConfig.from_env({"GENERAL_REGION_DETECTION": "1"}).enabled)
        self.assertFalse(RegionConfig.from_env({"GENERAL_REGION_DETECTION": "off"}).enabled)

    def test_inteiro_invalido_cai_no_default(self):
        cfg = RegionConfig.from_env({"GENERAL_REGION_MIN_SIZE": "92%", "GENERAL_REGION_MAX": ""})
        self.assertEqual(cfg.min_size, 320)
        self.assertEqual(cfg.max_regions, RegionConfig().max_regions)

    def test_nan_e_infinito_caem_no_default(self):
        for raw in ("nan", "NaN", "inf", "-inf", "abc"):
            cfg = RegionConfig.from_env({"GENERAL_REGION_MARGIN": raw})
            self.assertEqual(cfg.margin, RegionConfig().margin, f"'{raw}' não pode virar margem")

    def test_valores_fora_de_faixa_sao_limitados(self):
        cfg = RegionConfig.from_env({"GENERAL_REGION_MAX": "0", "GENERAL_REGION_STATIONARY_IOU": "5"})
        self.assertGreaterEqual(cfg.max_regions, 1, "teto zero deixaria o pipeline sem nenhuma região")
        self.assertLessEqual(cfg.stationary_iou, 1.0)

    def test_valores_validos_sao_lidos(self):
        cfg = RegionConfig.from_env(
            {
                "GENERAL_REGION_DETECTION": "yes",
                "GENERAL_REGION_MIN_SIZE": "416",
                "GENERAL_REGION_MARGIN": "1.5",
                "GENERAL_REGION_MAX": "6",
            }
        )
        self.assertTrue(cfg.enabled)
        self.assertEqual((cfg.min_size, cfg.margin, cfg.max_regions), (416, 1.5, 6))


class TestCalculateRegion(unittest.TestCase):
    """Região quadrada com margem, nunca menor que o mínimo, nunca fora do frame."""

    def test_alvo_pequeno_vira_regiao_do_tamanho_minimo(self):
        # Pessoa distante: 40×30 px num frame 1080p.
        box = (1500, 800, 1540, 830)
        region = calculate_region(FRAME, *box, 320, 1.35)
        self.assertEqual(region[2] - region[0], 320)
        self.assertEqual(region[3] - region[1], 320)
        self.assertTrue(_covers(region, box), "a região tem de conter a caixa de origem")
        self.assertTrue(_inside_frame(region))

    def test_margem_multiplica_a_caixa(self):
        box = (600, 400, 1000, 800)  # 400×400
        sem_margem = calculate_region(FRAME, *box, 320, 1.0)
        com_margem = calculate_region(FRAME, *box, 320, 1.35)
        self.assertGreater(
            com_margem[2] - com_margem[0],
            sem_margem[2] - sem_margem[0],
            "o MOG2 marca só o que se MOVEU (as pernas): sem margem o modelo não vê o corpo",
        )
        self.assertGreaterEqual(com_margem[2] - com_margem[0], int(400 * 1.35) - 4)
        self.assertTrue(_covers(com_margem, box))

    def test_regiao_encostada_na_borda_entra_no_frame(self):
        box = (10, 10, 60, 70)  # canto superior esquerdo
        region = calculate_region(FRAME, *box, 320, 1.35)
        self.assertEqual(region[0], 0)
        self.assertEqual(region[1], 0)
        self.assertTrue(_inside_frame(region))
        self.assertTrue(_covers(region, box))

        box = (1880, 1040, 1919, 1079)  # canto inferior direito
        region = calculate_region(FRAME, *box, 320, 1.35)
        self.assertTrue(_inside_frame(region))
        self.assertTrue(_covers(region, box))

    def test_regiao_nunca_estoura_o_frame(self):
        # Caixa mais larga que a altura do frame: a região quadrada de 1600 px não
        # cabe em 1080 de altura. Estourar aqui viraria uma fatia numpy truncada em
        # silêncio (o recorte sai menor do que a região calculada).
        box = (100, 500, 1700, 560)
        region = calculate_region(FRAME, *box, 320, 1.35)
        self.assertTrue(_inside_frame(region), f"região {region} fora do frame {FRAME}")
        self.assertTrue(_covers(region, box), "a caixa larga não pode ser cortada")


class TestBuildRegions(unittest.TestCase):
    def _cfg(self, **kwargs):
        return RegionConfig(enabled=True, **kwargs)

    def test_sem_caixas_nao_ha_regiao(self):
        self.assertEqual(build_regions(FRAME, [], self._cfg()), [])

    def test_caixas_proximas_viram_uma_regiao(self):
        # Duas partes do mesmo objeto (tronco e pernas) a poucos pixels.
        a = (900, 500, 940, 560)
        b = (945, 505, 985, 565)
        regions = build_regions(FRAME, [a, b], self._cfg())
        self.assertEqual(len(regions), 1, "caixas coladas não podem virar dois recortes")
        self.assertTrue(_covers(regions[0], a))
        self.assertTrue(_covers(regions[0], b))

    def test_caixas_distantes_viram_regioes_separadas(self):
        # Pessoa num canto e carro no outro: juntar seria voltar ao frame inteiro.
        a = (60, 60, 120, 200)
        b = (1750, 900, 1880, 1040)
        regions = build_regions(FRAME, [a, b], self._cfg())
        self.assertEqual(len(regions), 2)
        self.assertTrue(any(_covers(r, a) for r in regions))
        self.assertTrue(any(_covers(r, b) for r in regions))
        for region in regions:
            self.assertLess(
                (region[2] - region[0]) * (region[3] - region[1]),
                FRAME[0] * FRAME[1] // 2,
                "região do tamanho do frame anula o ganho de resolução",
            )

    def test_teto_de_regioes_funde_em_vez_de_descartar(self):
        # 6 focos de movimento com teto 3: NADA pode ser descartado (é gravação
        # probatória) — as regiões se FUNDEM até caber no teto.
        boxes = [
            (100, 100, 160, 220),
            (500, 120, 560, 240),
            (900, 140, 960, 260),
            (1300, 700, 1360, 820),
            (1700, 720, 1760, 840),
            (200, 900, 260, 1020),
        ]
        regions = build_regions(FRAME, boxes, self._cfg(max_regions=3))
        self.assertLessEqual(len(regions), 3)
        for box in boxes:
            self.assertTrue(
                any(_covers(region, box) for region in regions),
                f"caixa {box} ficou de fora das regiões {regions}",
            )

    def test_caixas_degeneradas_e_fora_do_frame_sao_ignoradas(self):
        boxes = [
            (100, 100, 100, 200),      # largura 0
            (300, 300, 200, 200),      # invertida
            (-500, -500, -100, -100),  # fora do frame
            (900, 500, 960, 620),      # válida
        ]
        regions = build_regions(FRAME, boxes, self._cfg())
        self.assertEqual(len(regions), 1)
        self.assertTrue(_covers(regions[0], (900, 500, 960, 620)))

    def test_regiao_recortada_do_frame_cobre_o_alvo_em_resolucao_nativa(self):
        box = (1500, 800, 1540, 830)
        region = build_regions(FRAME, [box], self._cfg())[0]
        largura = region[2] - region[0]
        # 320 px de recorte contra 1920 do frame: o alvo chega ao modelo 6× maior.
        self.assertLessEqual(largura, 512)
        self.assertGreaterEqual(largura, 320)


class TestDedupe(unittest.TestCase):
    """Regiões vizinhas podem ver o MESMO objeto duas vezes."""

    def test_mesma_classe_sobreposta_vira_uma(self):
        a = person((100, 100, 160, 300), conf=0.7)
        b = person((104, 102, 165, 305), conf=0.9)
        out = dedupe_by_iou([a, b], 0.6)
        self.assertEqual(len(out), 1)
        self.assertAlmostEqual(out[0].confidence, 0.9, places=4, msg="fica a de maior confiança")

    def test_classes_diferentes_sobrepostas_sobrevivem(self):
        pessoa = person((100, 100, 160, 300), conf=0.7, cls=0)
        moto = person((100, 100, 160, 300), conf=0.6, cls=3)
        out = dedupe_by_iou([pessoa, moto], 0.6)
        self.assertEqual(len(out), 2, "pessoa em cima da moto são dois objetos")

    def test_objetos_distantes_nao_se_fundem(self):
        a = person((100, 100, 160, 300))
        b = person((1500, 700, 1560, 900))
        self.assertEqual(len(dedupe_by_iou([a, b], 0.6)), 2)

    def test_ordem_de_entrada_e_preservada(self):
        a = person((100, 100, 160, 300), conf=0.4)
        b = person((900, 100, 960, 300), conf=0.9)
        out = dedupe_by_iou([a, b], 0.6)
        self.assertEqual([d.bbox for d in out], [a.bbox, b.bbox])


class TestPlannerRegioesDeMovimento(unittest.TestCase):
    def _planner(self, **kwargs):
        kwargs.setdefault("sweep_every", 0)
        return MotionRegionPlanner(RegionConfig(enabled=True, **kwargs))

    def test_movimento_gera_regiao_sobre_o_movimento(self):
        planner = self._planner()
        plan = planner.plan(FRAME, [(1500, 800, 1540, 830)])
        self.assertEqual(len(plan.regions), 1)
        self.assertTrue(_covers(plan.regions[0], (1500, 800, 1540, 830)))
        self.assertFalse(plan.idle)

    def test_sem_movimento_e_sem_cache_roda_o_frame_inteiro(self):
        # Cena parada: mantém EXATAMENTE o que o sistema faz hoje (frame inteiro),
        # em vez de deixar de inferir.
        planner = self._planner()
        plan = planner.plan(FRAME, [])
        self.assertEqual(plan.regions, [(0, 0, 1920, 1080)])
        self.assertTrue(plan.idle)

    def test_varredura_periodica_inclui_o_frame_inteiro(self):
        planner = MotionRegionPlanner(RegionConfig(enabled=True, sweep_every=3))
        motion = [(1500, 800, 1540, 830)]
        primeiro = planner.plan(FRAME, motion)
        self.assertTrue(primeiro.sweep, "a primeira passada varre o frame inteiro (startup scan)")
        self.assertIn((0, 0, 1920, 1080), primeiro.regions)
        self.assertGreater(len(primeiro.regions), 1, "a varredura não substitui as regiões de alta resolução")
        planner.commit([], primeiro)
        segundo = planner.plan(FRAME, motion)
        self.assertFalse(segundo.sweep)
        self.assertNotIn((0, 0, 1920, 1080), segundo.regions)


class TestPlannerEstacionarios(unittest.TestCase):
    """Objeto parado não precisa de inferência nova a cada frame — mas não pode
    sumir, e tem de voltar a ser inferido assim que se mexe."""

    def _planner(self, **kwargs):
        kwargs.setdefault("sweep_every", 0)
        kwargs.setdefault("stationary_threshold", 2)
        kwargs.setdefault("stationary_interval", 10)
        return MotionRegionPlanner(RegionConfig(enabled=True, **kwargs))

    def _ver_objeto(self, planner, box, vezes, motion=None):
        """Roda N ciclos plan/commit com o objeto sempre no mesmo lugar."""
        saida = []
        for _ in range(vezes):
            plan = planner.plan(FRAME, motion if motion is not None else [box])
            saida = planner.commit([person(box)], plan)
        return saida

    def test_objeto_parado_e_carregado_sem_nova_inferencia(self):
        planner = self._planner()
        box = (1400, 700, 1460, 880)
        self._ver_objeto(planner, box, vezes=3)  # vira estacionário

        plan = planner.plan(FRAME, [])  # ninguém se mexeu
        self.assertEqual(plan.regions, [], "objeto parado não precisa de recorte novo")
        self.assertEqual(plan.skipped, 1)
        self.assertEqual([d.bbox for d in plan.carried], [list(box)])
        self.assertFalse(plan.idle, "há objeto em cache: não é preciso varrer o frame inteiro")

        saida = planner.commit([], plan)
        self.assertEqual([d.bbox for d in saida], [list(box)], "o objeto NÃO pode sumir da saída")
        self.assertTrue(saida[0].extra.get("stationary"))

    def test_objeto_que_volta_a_se_mover_e_reinferido(self):
        # Objeto GRANDE (carro 600×300) com movimento PEQUENO em cima dele (a porta
        # abrindo). A região montada em volta da porta NÃO contém o carro inteiro:
        # sem a checagem de interseção, o carro seguiria sendo servido do cache,
        # com a caixa velha, justamente no instante em que algo acontece nele.
        planner = self._planner()
        carro = (1000, 600, 1600, 900)
        self._ver_objeto(planner, carro, vezes=3)

        porta = (1050, 700, 1120, 800)
        plan = planner.plan(FRAME, [porta])
        self.assertFalse(
            any(_covers(region, carro) for region in build_regions(FRAME, [porta], planner.config)),
            "premissa do caso: a região do movimento não cobre o objeto inteiro",
        )
        self.assertEqual(plan.carried, [], "com movimento encostando nele não pode ser pulado")
        self.assertEqual(plan.skipped, 0)
        self.assertTrue(
            any(_covers(region, carro) for region in plan.regions),
            "tem de sair uma região que cubra o objeto inteiro para reinferir",
        )

    def test_movimento_longe_nao_reinfere_o_estacionario(self):
        # O contrário do caso acima: movimento do outro lado da cena não pode
        # obrigar a reinferir tudo (senão o pulo não existe na prática).
        planner = self._planner()
        carro = (1000, 600, 1600, 900)
        self._ver_objeto(planner, carro, vezes=3)

        plan = planner.plan(FRAME, [(100, 100, 160, 220)])
        self.assertEqual([d.bbox for d in plan.carried], [list(carro)])
        self.assertEqual(plan.skipped, 1)

    def test_recheca_periodicamente_mesmo_parado(self):
        planner = self._planner(stationary_interval=4)
        box = (1400, 700, 1460, 880)
        self._ver_objeto(planner, box, vezes=3)

        pulos = 0
        forcado = False
        for _ in range(6):
            plan = planner.plan(FRAME, [])
            if plan.regions:
                forcado = True
                break
            pulos += 1
            planner.commit([], plan)
        self.assertTrue(forcado, "sem re-checagem periódica o cache viraria fantasma eterno")
        self.assertGreaterEqual(pulos, 1, "a re-checagem não pode ser a cada frame (senão não pulou nada)")

    def test_objeto_some_quando_a_regiao_roda_e_nao_o_encontra(self):
        planner = self._planner(stationary_interval=1)
        box = (1400, 700, 1460, 880)
        self._ver_objeto(planner, box, vezes=3)

        plan = planner.plan(FRAME, [])  # interval=1 → re-checagem forçada
        self.assertTrue(plan.regions)
        saida = planner.commit([], plan)  # a região rodou e não achou nada
        self.assertEqual(saida, [], "objeto que saiu de cena não pode continuar sendo reportado")

        plan = planner.plan(FRAME, [])
        self.assertEqual(plan.carried, [])
        self.assertTrue(plan.idle)

    def test_cache_expira_por_idade(self):
        planner = self._planner(stationary_interval=10_000, stationary_max_age=3)
        box = (1400, 700, 1460, 880)
        self._ver_objeto(planner, box, vezes=3)
        for _ in range(5):
            plan = planner.plan(FRAME, [])
            planner.commit([], plan)
        plan = planner.plan(FRAME, [])
        self.assertEqual(plan.carried, [], "entrada velha demais tem de morrer")

    def test_skip_desligado_sempre_infere(self):
        planner = self._planner(stationary_skip=False)
        box = (1400, 700, 1460, 880)
        self._ver_objeto(planner, box, vezes=3)
        plan = planner.plan(FRAME, [])
        self.assertEqual(plan.carried, [])
        self.assertTrue(any(_covers(r, box) for r in plan.regions))

    def test_objeto_que_se_desloca_nao_conta_como_parado(self):
        planner = self._planner(stationary_threshold=2)
        for passo in range(4):
            box = (1000 + passo * 120, 600, 1060 + passo * 120, 780)
            plan = planner.plan(FRAME, [box])
            planner.commit([person(box)], plan)
        plan = planner.plan(FRAME, [])
        self.assertEqual(plan.carried, [], "quem anda não é estacionário — tem de continuar sendo inferido")

    def test_deteccao_fresca_ganha_da_carregada(self):
        planner = self._planner()
        box = (1400, 700, 1460, 880)
        self._ver_objeto(planner, box, vezes=3)
        plan = planner.plan(FRAME, [])
        fresca = person((1402, 702, 1462, 882), conf=0.95)
        saida = planner.commit([fresca], plan)
        self.assertEqual(len(saida), 1, "a mesma pessoa não pode aparecer duas vezes")
        self.assertAlmostEqual(saida[0].confidence, 0.95, places=4)


class TestGeometria(unittest.TestCase):
    def test_iou(self):
        self.assertAlmostEqual(intersection_over_union((0, 0, 10, 10), (0, 0, 10, 10)), 1.0)
        self.assertAlmostEqual(intersection_over_union((0, 0, 10, 10), (20, 20, 30, 30)), 0.0)
        self.assertAlmostEqual(intersection_over_union((0, 0, 10, 10), (0, 0, 10, 5)), 0.5)

    def test_box_inside_e_intersects(self):
        self.assertTrue(box_inside((0, 0, 100, 100), (10, 10, 20, 20)))
        self.assertFalse(box_inside((0, 0, 100, 100), (10, 10, 200, 20)))
        self.assertTrue(boxes_intersect((0, 0, 100, 100), (90, 90, 200, 200)))
        self.assertFalse(boxes_intersect((0, 0, 100, 100), (101, 101, 200, 200)))


if __name__ == "__main__":
    unittest.main()
