"""Testes do backoff de reconexão (puro, sem cv2)."""

import unittest

from reconnect_backoff import compute_reconnect_delay


class TestReconnectBackoff(unittest.TestCase):
    def test_cresce_exponencialmente(self):
        self.assertEqual(compute_reconnect_delay(1, jitter=0), 1.0)
        self.assertEqual(compute_reconnect_delay(2, jitter=0), 2.0)
        self.assertEqual(compute_reconnect_delay(3, jitter=0), 4.0)
        self.assertEqual(compute_reconnect_delay(4, jitter=0), 8.0)

    def test_respeita_o_teto(self):
        # 2^9 = 512, capado em 60
        self.assertEqual(compute_reconnect_delay(10, jitter=0), 60.0)
        self.assertEqual(compute_reconnect_delay(100, jitter=0), 60.0)

    def test_base_configuravel(self):
        self.assertEqual(compute_reconnect_delay(1, base=2.0, jitter=0), 2.0)
        self.assertEqual(compute_reconnect_delay(2, base=2.0, jitter=0), 4.0)

    def test_attempt_invalido_vira_1(self):
        self.assertEqual(compute_reconnect_delay(0, jitter=0), 1.0)
        self.assertEqual(compute_reconnect_delay(-5, jitter=0), 1.0)

    def test_jitter_fica_dentro_dos_limites(self):
        # attempt=3 → base 4.0; com jitter 0.2 → [3.2, 4.8]
        for _ in range(200):
            d = compute_reconnect_delay(3, jitter=0.2)
            self.assertGreaterEqual(d, 3.2 - 1e-9)
            self.assertLessEqual(d, 4.8 + 1e-9)


if __name__ == "__main__":
    unittest.main()
