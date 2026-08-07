"""O tripwire está REALMENTE ligado ao pipeline?

Os testes de `test_tripwire.py` provam a geometria. Estes provam a AMARRAÇÃO —
o tipo de coisa que passa despercebida porque o código "parece certo": um
import faltando, o detector instanciado mas nunca chamado, ou chamado no ramo
que não tem rastreamento.

Rodam sem cv2 lendo o FONTE do stream_processor. É feio de propósito: importar
o módulo exigiria a stack de ML inteira, e o que se quer verificar aqui é
estrutural.
"""
import ast
import pathlib
import unittest

FONTE = pathlib.Path(__file__).resolve().parents[1] / "stream_processor.py"


class TripwireIntegracaoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.texto = FONTE.read_text(encoding="utf-8")
        cls.arvore = ast.parse(cls.texto)

    def test_tudo_que_o_tripwire_usa_esta_importado(self):
        """Import faltando só apareceria em produção, no primeiro cruzamento.

        Foi o que aconteceu ao ligar isto: `Detection` era usado no bloco novo e
        não estava importado. Os testes existentes não pegaram porque nenhum
        deles chega a esse ramo (exige a stack de ML).
        """
        importados = set()
        for no in ast.walk(self.arvore):
            if isinstance(no, ast.ImportFrom):
                importados.update(a.asname or a.name for a in no.names)
            elif isinstance(no, ast.Import):
                importados.update((a.asname or a.name).split(".")[0] for a in no.names)
        for nome in ("Detection", "DetectorDeTravessia"):
            self.assertIn(nome, importados, f"{nome} usado sem import")

    def test_o_detector_e_instanciado_com_as_zonas(self):
        self.assertIn("DetectorDeTravessia(self.detection_zones)", self.texto,
                      "o tripwire não recebe as linhas da câmera")

    def test_e_alimentado_no_ramo_QUE_TEM_RASTREAMENTO(self):
        """A amarração que importa.

        O caminho semântico passa `context_key=None` (sem tracking) de
        propósito. Alimentar o tripwire ali daria sempre zero travessias — sem
        identidade entre quadros não há trajeto — e o defeito seria invisível:
        nenhum erro, nenhum log, só perímetro que nunca dispara.
        """
        i = self.texto.index("self.tripwire.avaliar(")
        # Recorta o contexto ANTERIOR à chamada e confirma que a inferência
        # daquele ramo usa context_key=self.camera_id.
        contexto = self.texto[max(0, i - 3000):i]
        self.assertIn("context_key=self.camera_id", contexto,
                      "o tripwire está no ramo SEM rastreamento — nunca detectaria travessia")
        self.assertIn("advanced_detections", self.texto[i:i + 200],
                      "não está recebendo as detecções rastreadas")

    def test_so_a_travessia_proibida_vira_evento(self):
        i = self.texto.index("self.tripwire.avaliar(")
        bloco = self.texto[i:i + 1500]
        self.assertIn('t.get("proibido")', bloco,
                      "travessia no sentido permitido viraria alarme")
        self.assertIn('event_type="LINE_CROSSED"', bloco)

    def test_o_evento_carrega_o_que_o_operador_precisa(self):
        i = self.texto.index("self.tripwire.avaliar(")
        bloco = self.texto[i:i + 1500]
        # Sem o nome da linha e o sentido, o alarme diz "cruzou" sem dizer
        # ONDE nem PARA ONDE — inútil numa instalação com várias linhas.
        for campo in ('"linhaNome"', '"sentido"', '"linhaId"'):
            self.assertIn(campo, bloco, f"o evento não carrega {campo}")

    def test_falha_do_tripwire_nao_derruba_a_analise(self):
        """Perímetro quebrado não pode cegar a câmera inteira."""
        i = self.texto.index("self.tripwire.avaliar(")
        bloco = self.texto[max(0, i - 300):i + 1800]
        self.assertIn("except Exception", bloco, "sem proteção, um erro aqui mata a detecção toda")

    def test_sem_linha_desenhada_nao_ha_custo(self):
        i = self.texto.index("self.tripwire.avaliar(")
        contexto = self.texto[max(0, i - 400):i]
        self.assertIn("self.tripwire.ativo", contexto,
                      "roda mesmo sem linha configurada — custo sem pedido")


if __name__ == "__main__":
    unittest.main()
