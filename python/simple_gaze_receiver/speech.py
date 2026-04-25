# speech.py
"""Background TTS worker for ovision. Non-blocking speak() with dedup."""

import queue
import threading
import time

try:
    import pyttsx3
except ImportError:
    pyttsx3 = None

try:
    import pythoncom  # for CoInitialize on Windows worker thread
except ImportError:
    pythoncom = None


class SpeechEngine:
    def __init__(self, rate: int = 180, voice_id: str | None = None,
                 dedup_window: float = 5.0):
        self.rate         = rate
        self.voice_id     = voice_id
        self.dedup_window = dedup_window
        self._recent: dict[str, float] = {}
        self._lock = threading.Lock()
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._muted = False
        self._enabled = pyttsx3 is not None

        if pyttsx3 is None:
            print("[Speech] pyttsx3 not installed — TTS disabled.")
            return

        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def speak(self, text: str):
        if not text or not self._enabled or self._muted:
            return
        text = text.strip()
        if not text:
            return
        key = text.lower()
        now = time.time()
        with self._lock:
            last = self._recent.get(key, 0)
            if now - last < self.dedup_window:
                return
            self._recent[key] = now
            cutoff = now - self.dedup_window * 4
            self._recent = {k: t for k, t in self._recent.items() if t > cutoff}
        self._queue.put(text)

    def toggle_mute(self) -> bool:
        self._muted = not self._muted
        print(f"[Speech] {'muted' if self._muted else 'unmuted'}")
        return self._muted

    def stop(self):
        self._queue.put(None)

    def _run(self):
        # IMPORTANT: pyttsx3 SAPI driver must be initialised in the SAME thread
        # that calls runAndWait(), otherwise speech is silent on Windows.
        if pythoncom is not None:
            try:
                pythoncom.CoInitialize()
            except Exception:
                pass

        print(f"[Speech] engine ready (rate={self.rate}).")

        while True:
            text = self._queue.get()
            if text is None:
                return
            # Re-init engine per utterance — works around pyttsx3 SAPI bug
            # where runAndWait() locks up the driver after the first call.
            try:
                engine = pyttsx3.init()
                engine.setProperty("rate", self.rate)
                if self.voice_id:
                    engine.setProperty("voice", self.voice_id)
                engine.say(text)
                engine.runAndWait()
                try:
                    engine.stop()
                except Exception:
                    pass
                del engine
            except Exception as exc:
                print(f"[Speech] say failed: {exc}")
