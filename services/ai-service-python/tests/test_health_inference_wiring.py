"""Ligação do watchdog de inferência ao /health (item 1, parte de fiação).

`main.py` importa fastapi/uvicorn — ausentes no host E no container de teste.
Como os testes já fazem no 4.4 (test_service_logging.py), as garantias de
fiação são lidas do CÓDIGO-FONTE via `ast`/texto, e a lógica de verdade fica em
funções puras (inference_watchdog) exercitadas de verdade aqui.

O que estes testes travam:
  • o /health publica o estado de inferência por processador e a lista nova
    `inference_degraded_processors`;
  • o `degraded_processors` (que REINICIA análise no api) só recebe inferência
    travada através de `merge_degraded` + flag — nunca direto;
  • um processador que exploda ao calcular o estado NÃO derruba o /health e NÃO
    é reportado como degradado (falso alarme > silêncio, aqui, é falso).

Framework: unittest da stdlib (decisão 9.2).
"""

import ast
import os
import unittest

from inference_watchdog import STATUS_NOT_APPLICABLE, safe_inference_state

SVC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(name: str) -> str:
    with open(os.path.join(SVC_DIR, name), "r", encoding="utf-8") as handle:
        return handle.read()


class TestHealthPublicaInferencia(unittest.TestCase):
    def setUp(self):
        self.source = _read("main.py")

    def test_main_importa_o_watchdog_de_inferencia(self):
        self.assertIn("from inference_watchdog import", self.source)

    def test_health_expoe_estado_por_processador(self):
        self.assertIn('"inference": inference_states', self.source)

    def test_health_expoe_lista_separada_de_inferencia_degradada(self):
        self.assertIn('"inference_degraded_processors"', self.source)

    def test_health_expoe_os_runtimes_de_detector(self):
        self.assertIn('"detector_runtimes"', self.source)

    def test_degraded_processors_passa_por_merge_com_flag(self):
        # A lista que o api usa para REINICIAR câmera não pode ganhar entradas
        # novas sem passar pelo merge com a flag.
        self.assertIn("merge_degraded(", self.source)
        self.assertIn("enforcement_enabled", self.source)

    def test_estado_por_processador_e_calculado_de_forma_segura(self):
        self.assertIn("safe_inference_state(", self.source)

    def _health_source(self) -> str:
        tree = ast.parse(self.source)
        node = next(
            n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "health_check"
        )
        return ast.unparse(node)

    def test_health_le_os_processadores_de_um_snapshot_unico(self):
        # O dict global `processors` muda enquanto o /health monta a resposta
        # (start/stop concorrente). Ler `processors.items()` mais de uma vez
        # deixa dicionários com chaves diferentes e o lookup cruzado
        # (readiness[camera_id] / inference_states[camera_id]) estoura KeyError
        # → 500 no /health → o api conclui que o ai-service caiu.
        body = self._health_source()
        self.assertEqual(
            body.count("processors.items()"),
            1,
            "o /health deve tirar UM snapshot de processors e reutilizá-lo",
        )
        self.assertNotIn("processors.keys()", body)

    def test_main_continua_sem_print(self):
        tree = ast.parse(self.source)
        prints = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "print"
        ]
        self.assertEqual(prints, [])


class _Explodindo:
    advanced_analysis_type = "general"

    def inference_state(self, **kwargs):
        raise RuntimeError("boom")


class _Silencioso:
    advanced_analysis_type = None

    def inference_state(self, **kwargs):
        return {"status": STATUS_NOT_APPLICABLE, "degraded": False, "applicable": False}


class TestFailSafeDoEstado(unittest.TestCase):
    def test_processador_que_explode_nao_derruba_o_health(self):
        state = safe_inference_state(_Explodindo(), capture_ready=True, now=1.0)
        self.assertFalse(state["degraded"], "erro ao medir NÃO pode virar alarme")
        self.assertEqual(state["status"], "unknown")
        self.assertIn("boom", str(state["last_error"]))

    def test_estado_normal_passa_intacto(self):
        state = safe_inference_state(_Silencioso(), capture_ready=True, now=1.0)
        self.assertEqual(state["status"], STATUS_NOT_APPLICABLE)
        self.assertFalse(state["degraded"])

    def test_objeto_sem_o_metodo_nao_quebra(self):
        state = safe_inference_state(object(), capture_ready=True, now=1.0)
        self.assertFalse(state["degraded"])
        self.assertEqual(state["status"], "unknown")


if __name__ == "__main__":
    unittest.main()
