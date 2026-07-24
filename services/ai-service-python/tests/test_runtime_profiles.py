"""Testes de caracterização de runtime_profiles (lógica pura, sem cv2/numpy).

Framework: unittest da stdlib (decisão 9.2 — pytest não está instalado e o
serviço não deve ganhar dependência nova só para testar; unittest é zero-install).
Rodar da raiz do serviço:
    python3 -m unittest discover -s tests -t .
ou da raiz do repo:
    python3 -m unittest discover -s services/ai-service-python/tests -t services/ai-service-python
"""

import unittest

import runtime_profiles as rp


class TestRuntimeProfileSelection(unittest.TestCase):
    def test_seleciona_perfil_por_modo(self):
        self.assertEqual(rp.runtime_profile("motion")["mode"], "motion")
        self.assertEqual(rp.runtime_profile("face")["mode"], "face")
        self.assertEqual(rp.runtime_profile("general")["mode"], "general")

    def test_modo_e_case_insensitive_e_ignora_espacos(self):
        self.assertEqual(rp.runtime_profile("  FACE ")["mode"], "face")
        self.assertEqual(rp.runtime_profile("General")["mode"], "general")

    def test_modo_desconhecido_ou_vazio_cai_para_motion(self):
        # Invariante de segurança: qualquer entrada inesperada NÃO deve quebrar,
        # deve degradar para o perfil de movimento (o mais barato/base).
        self.assertEqual(rp.runtime_profile("bogus")["mode"], "motion")
        self.assertEqual(rp.runtime_profile("")["mode"], "motion")
        self.assertEqual(rp.runtime_profile(None)["mode"], "motion")

    def test_retorna_copia_isolada_do_dict_do_modulo(self):
        # Invariante: o chamador não pode mutar o perfil global do módulo.
        a = rp.runtime_profile("general")
        a["mode"] = "adulterado"
        b = rp.runtime_profile("general")
        self.assertEqual(b["mode"], "general", "runtime_profile deve devolver cópia, não a referência global")

    def test_face_profile_tem_modelo_esperado(self):
        face = rp.runtime_profile("face")
        self.assertEqual(face["model"], "scrfd_500m")
        self.assertFalse(face["recognition"], "reconhecimento de rosto é dormente por padrão")


class TestOnnxProviders(unittest.TestCase):
    def test_cuda_e_gpu_pedem_cuda_com_fallback_cpu(self):
        self.assertEqual(
            rp.onnxruntime_providers("onnxruntime_cuda"),
            ["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        self.assertEqual(
            rp.onnxruntime_providers("algo-GPU"),
            ["CUDAExecutionProvider", "CPUExecutionProvider"],
        )

    def test_default_e_cpu_only(self):
        self.assertEqual(rp.onnxruntime_providers("onnxruntime_cpu"), ["CPUExecutionProvider"])
        self.assertEqual(rp.onnxruntime_providers(None), ["CPUExecutionProvider"])
        self.assertEqual(rp.onnxruntime_providers(""), ["CPUExecutionProvider"])

    def test_runtime_uses_gpu(self):
        self.assertTrue(rp.runtime_uses_gpu("onnxruntime_cuda"))
        self.assertTrue(rp.runtime_uses_gpu("GPU"))
        self.assertFalse(rp.runtime_uses_gpu("onnxruntime_cpu"))
        self.assertFalse(rp.runtime_uses_gpu(None))


class TestExposedProfiles(unittest.TestCase):
    def test_expoe_face_e_general_com_listas_serializaveis(self):
        exposed = rp.exposed_profiles()
        self.assertIn("face", exposed)
        self.assertIn("general", exposed)
        # classes/class_ids devem sair como list (JSON-serializável), não tuple.
        self.assertIsInstance(exposed["general"]["classes"], list)
        self.assertIsInstance(exposed["general"]["class_ids"], list)


if __name__ == "__main__":
    unittest.main()
