"""Normalização de contraste: caminho rápido BIT-EXATO.

Medido no bench de 2026-07-27, a normalização de contraste respondia por ~52%
do custo por frame do detector de movimento — mais que o próprio MOG2. O custo
não estava no conceito, e sim em COMO estava escrito:

  * `np.percentile` ORDENA o array inteiro (57.600 elementos a 320×180), duas
    vezes por frame, para extrair dois números;
  * o esticamento alocava dois/três buffers float32 do tamanho do frame para
    aplicar uma função que, sendo a entrada uint8, só tem 256 respostas
    possíveis.

As duas reescritas abaixo são EXATAMENTE equivalentes, não aproximações:

  * o percentil sai de um histograma de 256 bins com a MESMA interpolação
    linear do NumPy (`np.percentile` interpola entre as estatísticas de ordem
    que cercam o posto `(n-1)*q`);
  * o esticamento vira uma LUT de 256 entradas + `cv2.LUT`, reproduzindo o
    mesmo `clip → subtrai → multiplica → TRUNCA` do `astype(uint8)`.

Estes testes existem para travar a palavra "exatamente". Um caminho rápido que
divergisse por 1 nível mudaria silenciosamente a sensibilidade do detector em
todas as câmeras, e o sintoma apareceria como "está detectando de menos" meses
depois — sem nada no log.
"""

import unittest

import numpy as np

try:
    import cv2  # noqa: F401
    from detectors.motion_contrast import stretch_lut, uint8_percentile
    HAS_CV2 = True
except Exception:  # pragma: no cover - ambiente local sem opencv
    HAS_CV2 = False


def naive_percentile(gray, q):
    """A implementação que existia antes — a referência a bater."""
    return float(np.percentile(gray, q))


def naive_stretch(frame, lo, hi):
    """O esticamento original, incluindo o TRUNCAMENTO do astype(uint8)."""
    stretched = (np.clip(frame.astype(np.float32), lo, hi) - lo) * (255.0 / (hi - lo))
    return stretched.astype(np.uint8)


@unittest.skipUnless(HAS_CV2, "exige cv2 → roda no container")
class Uint8PercentileTest(unittest.TestCase):
    def test_bate_com_numpy_em_ruido_aleatorio(self):
        rng = np.random.default_rng(20260728)
        for _ in range(200):
            gray = rng.integers(0, 256, size=(180, 320), dtype=np.uint8)
            for q in (4.0, 96.0):
                self.assertAlmostEqual(
                    uint8_percentile(gray, q),
                    naive_percentile(gray, q),
                    places=9,
                    msg=f"divergência no percentil {q}",
                )

    def test_cenas_reais_extremas(self):
        """Casos que o ruído uniforme NUNCA sorteia — e que são o dia a dia."""
        casos = {
            "cena_uniforme": np.full((180, 320), 128, np.uint8),
            "noite_quase_preta": np.zeros((180, 320), np.uint8),
            "estourada_branca": np.full((180, 320), 255, np.uint8),
            "dois_niveis": np.where(
                np.indices((180, 320))[0] < 90, np.uint8(10), np.uint8(240)
            ).astype(np.uint8),
            "um_pixel_claro": np.pad(
                np.zeros((179, 320), np.uint8), ((0, 1), (0, 0)), constant_values=255
            ),
            "infravermelho_faixa_estreita": np.full((180, 320), 60, np.uint8)
            | np.random.default_rng(7).integers(0, 4, (180, 320), dtype=np.uint8),
        }
        for nome, gray in casos.items():
            for q in (4.0, 96.0):
                with self.subTest(cena=nome, q=q):
                    self.assertAlmostEqual(
                        uint8_percentile(gray, q), naive_percentile(gray, q), places=9
                    )

    def test_frame_minusculo_onde_a_interpolacao_de_fato_pesa(self):
        """Com poucos pixels, quase todo posto cai ENTRE duas amostras.

        É aqui que um histograma ingênuo (posto mais próximo, sem interpolar)
        divergiria — e é por isso que este teste usa tamanhos pequenos.
        """
        rng = np.random.default_rng(99)
        for n in (2, 3, 5, 7, 11, 25):
            for _ in range(50):
                gray = rng.integers(0, 256, size=n, dtype=np.uint8)
                for q in (4.0, 25.0, 50.0, 96.0):
                    self.assertAlmostEqual(
                        uint8_percentile(gray, q), naive_percentile(gray, q), places=9
                    )

    def test_aceita_frame_de_3_canais_achatado(self):
        rng = np.random.default_rng(5)
        gray = rng.integers(0, 256, size=(90, 160), dtype=np.uint8)
        self.assertAlmostEqual(uint8_percentile(gray, 50.0), naive_percentile(gray, 50.0), places=9)


@unittest.skipUnless(HAS_CV2, "exige cv2 → roda no container")
class StretchLutTest(unittest.TestCase):
    def test_bate_bit_a_bit_com_o_esticamento_antigo(self):
        rng = np.random.default_rng(20260728)
        for _ in range(120):
            frame = rng.integers(0, 256, size=(180, 320, 3), dtype=np.uint8)
            lo = float(rng.integers(0, 200))
            hi = lo + 1.0 + float(rng.integers(1, 55))
            esperado = naive_stretch(frame, lo, hi)
            obtido = stretch_lut(frame, lo, hi)
            self.assertTrue(
                np.array_equal(esperado, obtido),
                f"divergiu com lo={lo} hi={hi}: máx |Δ| = {int(np.abs(esperado.astype(int) - obtido.astype(int)).max())}",
            )

    def test_cobre_TODOS_os_256_valores_de_entrada(self):
        """O ruído aleatório cobre os 256 na média; aqui é por construção."""
        frame = np.arange(256, dtype=np.uint8).reshape(16, 16)
        for lo, hi in ((0.0, 255.0), (4.0, 251.0), (100.0, 101.5), (0.0, 1.0), (250.0, 255.0)):
            with self.subTest(lo=lo, hi=hi):
                self.assertTrue(np.array_equal(naive_stretch(frame, lo, hi), stretch_lut(frame, lo, hi)))

    def test_preserva_forma_e_dtype_em_1_e_3_canais(self):
        for shape in ((180, 320), (180, 320, 3)):
            frame = np.random.default_rng(3).integers(0, 256, size=shape, dtype=np.uint8)
            saida = stretch_lut(frame, 10.0, 200.0)
            self.assertEqual(saida.shape, frame.shape)
            self.assertEqual(saida.dtype, np.uint8)

    def test_lo_e_hi_fracionarios_da_media_movel(self):
        """`avg_lo`/`avg_hi` vêm de uma média de 50 frames: quase nunca são inteiros."""
        rng = np.random.default_rng(11)
        frame = rng.integers(0, 256, size=(120, 160), dtype=np.uint8)
        for lo, hi in ((3.7, 249.13), (12.5, 13.5), (0.001, 254.999), (63.25, 64.75)):
            with self.subTest(lo=lo, hi=hi):
                self.assertTrue(np.array_equal(naive_stretch(frame, lo, hi), stretch_lut(frame, lo, hi)))


if __name__ == "__main__":
    unittest.main()
