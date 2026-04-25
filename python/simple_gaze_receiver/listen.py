# listen.py
"""Voice input via SpeechRecognition + Google Web Speech API."""

import threading

try:
    import speech_recognition as sr
except ImportError:
    sr = None


class Listener:
    def __init__(self, language: str = "en-US"):
        self.language = language
        self._enabled = sr is not None
        self._recognizer = None
        self._mic = None
        if not self._enabled:
            print("[Listen] SpeechRecognition not installed — voice input disabled.")
            return
        try:
            self._recognizer = sr.Recognizer()
            self._mic = sr.Microphone()
            with self._mic as source:
                self._recognizer.adjust_for_ambient_noise(source, duration=0.5)
            print("[Listen] microphone ready.")
        except Exception as exc:
            print(f"[Listen] init failed: {exc} — voice input disabled.")
            self._enabled = False

    def listen_once(self, timeout: float = 5.0,
                    phrase_limit: float = 4.0) -> str | None:
        """Block-listen for one phrase. Returns transcribed text or None."""
        if not self._enabled:
            return None
        try:
            with self._mic as source:
                audio = self._recognizer.listen(
                    source, timeout=timeout, phrase_time_limit=phrase_limit
                )
            text = self._recognizer.recognize_google(audio, language=self.language)
            print(f"[Listen] heard: {text}")
            return text.strip()
        except sr.WaitTimeoutError:
            print("[Listen] timeout (no speech detected).")
            return None
        except sr.UnknownValueError:
            print("[Listen] could not understand audio.")
            return None
        except Exception as exc:
            print(f"[Listen] failed: {exc}")
            return None

    def listen_async(self, callback, timeout: float = 5.0,
                     phrase_limit: float = 4.0):
        """Listen in background thread, call callback(text_or_None) when done."""
        def _worker():
            text = self.listen_once(timeout, phrase_limit)
            callback(text)
        threading.Thread(target=_worker, daemon=True).start()
