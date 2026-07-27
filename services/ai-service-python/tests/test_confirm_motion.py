"""Testes do item 2.1 — confirm-motion FORA do event loop, fail-safe preservado.

Rodam SEM cv2 real: o orquestrador (`run_confirm_motion`) é puro asyncio, e
`capture_and_detect` é exercitado com um módulo cv2 FALSO injetado em sys.modules.
"""
import asyncio
import sys
import threading
import time
import types
import unittest

import confirm_motion


class RunConfirmMotionTests(unittest.IsolatedAsyncioTestCase):
    async def test_passthrough_confirmed_true(self):
        res = await confirm_motion.run_confirm_motion(
            lambda: {"confirmed": True, "reason": None, "labels": ["person"]},
            semaphore=asyncio.Semaphore(1),
        )
        self.assertEqual(res["confirmed"], True)

    async def test_confirmed_false_is_the_only_suppress(self):
        # frame lido e SEM objeto -> False deve PASSAR (única supressão legítima).
        res = await confirm_motion.run_confirm_motion(
            lambda: {"confirmed": False, "reason": "no_object", "labels": []},
            semaphore=asyncio.Semaphore(1),
        )
        self.assertEqual(res["confirmed"], False)

    async def test_failsafe_on_error_is_none_never_false(self):
        # INVARIANTE 1.3: erro da IA NUNCA pode virar False (isso suprimiria gravação).
        def boom():
            raise RuntimeError("modelo indisponível")

        res = await confirm_motion.run_confirm_motion(boom, camera_id="cam-x", semaphore=asyncio.Semaphore(1))
        self.assertIsNone(res["confirmed"])
        self.assertTrue(str(res["reason"]).startswith("error:"))

    async def test_failsafe_on_timeout_is_none(self):
        def slow():
            time.sleep(0.3)
            return {"confirmed": False, "reason": "no_object", "labels": []}

        res = await confirm_motion.run_confirm_motion(slow, deadline=0.05, semaphore=asyncio.Semaphore(1))
        self.assertIsNone(res["confirmed"])
        self.assertEqual(res["reason"], "timeout")

    async def test_runs_off_the_event_loop_thread(self):
        # O trabalho bloqueante roda em OUTRA thread (não trava o loop do uvicorn).
        loop_thread = threading.get_ident()
        seen = {}

        def capture_thread():
            seen["tid"] = threading.get_ident()
            return {"confirmed": None, "reason": "no_frame", "labels": []}

        await confirm_motion.run_confirm_motion(capture_thread, semaphore=asyncio.Semaphore(1))
        self.assertIn("tid", seen)
        self.assertNotEqual(seen["tid"], loop_thread)

    async def test_semaphore_bounds_concurrency(self):
        # Semaphore(1) => duas chamadas NÃO se sobrepõem (pico de concorrência == 1).
        sem = asyncio.Semaphore(1)
        state = {"cur": 0, "peak": 0}
        lock = threading.Lock()

        def work():
            with lock:
                state["cur"] += 1
                state["peak"] = max(state["peak"], state["cur"])
            time.sleep(0.1)
            with lock:
                state["cur"] -= 1
            return {"confirmed": None, "reason": "no_frame", "labels": []}

        await asyncio.gather(
            confirm_motion.run_confirm_motion(work, semaphore=sem),
            confirm_motion.run_confirm_motion(work, semaphore=sem),
        )
        self.assertEqual(state["peak"], 1)


class _Obj:
    def __init__(self, label, conf):
        self.label = label
        self.confidence = conf


def _fake_cv2(frames):
    class FakeCap:
        def __init__(self, *a, **k):
            self._frames = list(frames)

        def set(self, *a, **k):
            return True

        def read(self):
            if self._frames:
                return True, self._frames.pop(0)
            return False, None

        def release(self):
            pass

    mod = types.ModuleType("cv2")
    mod.CAP_FFMPEG = 0
    mod.CAP_PROP_OPEN_TIMEOUT_MSEC = 1
    mod.CAP_PROP_READ_TIMEOUT_MSEC = 2
    mod.CAP_PROP_BUFFERSIZE = 3
    mod.VideoCapture = FakeCap
    return mod


class CaptureAndDetectTests(unittest.TestCase):
    def setUp(self):
        self._had_cv2 = sys.modules.get("cv2")

    def tearDown(self):
        if self._had_cv2 is not None:
            sys.modules["cv2"] = self._had_cv2
        else:
            sys.modules.pop("cv2", None)

    def test_relevant_object_confirmed_true(self):
        sys.modules["cv2"] = _fake_cv2([object()])

        def ensure_detector(_name):
            class D:
                def infer(self, *a, **k):
                    return [_Obj("person", 0.9)]

            return D()

        res = confirm_motion.capture_and_detect("rtsp://x", ["person"], ensure_detector)
        self.assertEqual(res["confirmed"], True)
        self.assertIn("person", res["labels"])

    def test_frame_but_no_object_confirmed_false(self):
        sys.modules["cv2"] = _fake_cv2([object()])

        def ensure_detector(_name):
            class D:
                def infer(self, *a, **k):
                    return []

            return D()

        res = confirm_motion.capture_and_detect("rtsp://x", None, ensure_detector)
        self.assertEqual(res["confirmed"], False)
        self.assertEqual(res["reason"], "no_object")

    def test_no_frame_returns_none(self):
        sys.modules["cv2"] = _fake_cv2([])  # nenhum frame lido
        res = confirm_motion.capture_and_detect("rtsp://x", None, lambda _n: None)
        self.assertIsNone(res["confirmed"])
        self.assertEqual(res["reason"], "no_frame")

    def test_detector_error_is_failsafe_none(self):
        sys.modules["cv2"] = _fake_cv2([object()])

        def ensure_detector(_name):
            raise RuntimeError("modelo caiu")

        res = confirm_motion.capture_and_detect("rtsp://x", None, ensure_detector)
        self.assertIsNone(res["confirmed"])  # erro de inferência -> None, nunca False


if __name__ == "__main__":
    unittest.main()
