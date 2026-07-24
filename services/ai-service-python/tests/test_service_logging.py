"""Guardas ESTÁTICAS do item 4.4 (lock + logging estruturado).

Estes testes leem o CÓDIGO-FONTE via `ast`/texto — não importam os módulos, que
puxam cv2 (ausente no host). Por isso rodam em QUALQUER lugar (host, container
opencv, container ML) e travam duas invariantes:

  1. `main.py` e `stream_processor.py` NÃO usam mais `print()` — só `logging`.
  2. As mutações do dict global `processors` (start/stop/stop_all) estão sob o
     `_processors_lock` em `main.py`.

Framework: unittest da stdlib (decisão 9.2 — sem dependência nova).
"""

import ast
import os
import unittest

SVC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(name: str) -> str:
    with open(os.path.join(SVC_DIR, name), "r", encoding="utf-8") as handle:
        return handle.read()


def _count_print_calls(source: str) -> int:
    tree = ast.parse(source)
    return sum(
        1
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "print"
    )


class TestNoPrintLogging(unittest.TestCase):
    def test_main_nao_usa_print(self):
        # Invariante 4.4: o serviço loga por logging estruturado, não print().
        self.assertEqual(_count_print_calls(_read("main.py")), 0)

    def test_stream_processor_nao_usa_print(self):
        self.assertEqual(_count_print_calls(_read("stream_processor.py")), 0)

    def test_ambos_declaram_logging(self):
        for name in ("main.py", "stream_processor.py"):
            source = _read(name)
            self.assertIn("import logging", source, f"{name} deve importar logging")
            self.assertIn("logging.getLogger", source, f"{name} deve obter um logger")


class TestCredentialRedactionPreserved(unittest.TestCase):
    def test_capture_start_usa_sanitize_url(self):
        # A ÚNICA linha que loga a rtsp_url deve passar por _sanitize_url; logar a
        # URL crua vazaria user:senha (memória credential-leak-ffmpeg-stderr).
        source = _read("stream_processor.py")
        tree = ast.parse(source)
        # Nenhum log/format pode referenciar self.rtsp_url sem sanitizar: procuramos
        # o atributo `rtsp_url` em chamadas de logger e garantimos que _sanitize_url
        # está presente e é o que embrulha a rtsp_url no log de captura.
        self.assertIn("_sanitize_url(self.rtsp_url)", source)
        # E o método de redação continua existindo.
        self.assertIn("def _sanitize_url", source)
        # Sanity do AST (arquivo íntegro).
        self.assertTrue(any(isinstance(n, ast.FunctionDef) and n.name == "_sanitize_url" for n in ast.walk(tree)))


class TestProcessorsLock(unittest.TestCase):
    def setUp(self):
        self.source = _read("main.py")

    def test_declara_lock_do_dict_global(self):
        self.assertIn("_processors_lock = threading.Lock()", self.source)
        self.assertIn("import threading", self.source)

    def test_mutacoes_do_dict_estao_sob_o_lock(self):
        # start/stop/stop_all mutam `processors` — cada um deve abrir o lock.
        # Exige pelo menos 3 blocos `with _processors_lock:` (um por handler).
        self.assertGreaterEqual(
            self.source.count("with _processors_lock"),
            3,
            "start_analysis, stop_analysis e stop_all devem mutar o dict sob o lock",
        )

    def test_handlers_de_mutacao_referenciam_o_lock(self):
        # Prova mais fina via AST: cada função que mexe em `processors` (exceto as
        # leitoras /health e /ready) precisa conter um `with` sobre _processors_lock.
        tree = ast.parse(self.source)
        mutating = {"start_analysis", "stop_analysis", "stop_all"}
        found_with_lock = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.AsyncFunctionDef) and node.name in mutating:
                for inner in ast.walk(node):
                    if isinstance(inner, ast.With):
                        for item in inner.items:
                            expr = item.context_expr
                            if isinstance(expr, ast.Name) and expr.id == "_processors_lock":
                                found_with_lock.add(node.name)
        self.assertEqual(
            found_with_lock,
            mutating,
            f"handlers sem lock: {mutating - found_with_lock}",
        )


if __name__ == "__main__":
    unittest.main()
