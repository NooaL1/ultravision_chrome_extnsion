# process.py

import cv2
import collections
import time
import threading
import urllib.parse
import urllib.request
import json
import base64

from ultralytics import YOLO
from person_database import PersonDatabase
from speech import SpeechEngine
from listen import Listener
from profiles import ProfileStore

VGA_W, VGA_H = 640, 480

# ── Configuration ─────────────────────────────────────────────────────────────
SERPAPI_KEY = "2e046fcc720d02544597c5d60eb664fdfea7bd8e0b1f3718d2683fc24d62b7fe"

HIGHLIGHT_FADE = 8.0   # seconds the box + text stay visible
DWELL_SECONDS  = 1.5   # seconds gaze must dwell before trigger
DWELL_RADIUS   = 60    # pixel radius gaze must stay within

PUPIL_CHANGE_THRESHOLD = 0.08   # 8% pupil diameter change triggers search

# ── Ollama text model (description generator for detected objects) ───────────
OLLAMA_URL          = "http://localhost:11434/api/generate"
OLLAMA_MODEL        = "gemma3:1b"
OLLAMA_VISION_MODEL = "moondream"   # used only on R/T hotkey, not per-dwell
OLLAMA_TIMEOUT      = 10   # seconds
OLLAMA_VISION_TIMEOUT = 20

# Crop radius (px) around gaze for OCR / vision hotkeys
VISION_CROP_RADIUS = 180

# ── Text-to-speech config ─────────────────────────────────────────────────────
TTS_ENABLED      = True
TTS_RATE         = 180   # words per minute
TTS_DEDUP_WINDOW = 5.0   # seconds before same phrase can repeat

# ── Cognitive Load Tracker config ─────────────────────────────────────────────
CLT_WINDOW_SEC       = 30.0    # rolling window length (seconds)
CLT_PUPIL_BASELINE_SEC = 10.0  # first N seconds used to learn personal baseline
CLT_UPDATE_INTERVAL  = 0.25    # recalc score every 250 ms (not every frame)


# Person-overlay colours  (BGR)
PERSON_BOX_COLOR  = (0, 200, 255)   # amber/gold
UNKNOWN_BOX_COLOR = (120, 120, 120) # grey for unrecognised faces


# Category → colour mapping
CATEGORY_COLORS = {
    "phone":       (255, 100, 50),   # blue
    "tablet":      (200, 150, 50),   # teal
    "laptop":      (50, 200, 255),   # orange
    "desktop":     (50, 150, 200),   # brown-orange
    "peripheral":  (180, 120, 255),  # pink
    "audio":       (100, 255, 100),  # green
    "camera":      (0, 200, 200),    # yellow
    "wearable":    (255, 50, 150),   # purple
    "gaming":      (0, 100, 255),    # red
    "networking":  (200, 200, 50),   # cyan
    "storage":     (100, 180, 220),  # sand
    "smart_home":  (50, 255, 200),   # mint
    "power":       (80, 80, 220),    # dark red
    "maker":       (0, 180, 180),    # olive
    "other":       (180, 180, 180),  # grey
}

# Class name → category
CLASS_CATEGORY = {}
_cat_map = {
    "phone":      ["iPhone", "Samsung Galaxy phone", "Google Pixel phone", "foldable smartphone"],
    "tablet":     ["iPad Pro", "iPad mini", "Android tablet", "Kindle e-reader", "Microsoft Surface tablet"],
    "laptop":     ["MacBook laptop", "Dell XPS laptop", "ThinkPad laptop", "gaming laptop", "Chromebook"],
    "desktop":    ["computer monitor", "curved monitor", "desktop computer tower", "iMac desktop", "Mac mini"],
    "peripheral": ["computer mouse", "trackball mouse", "mechanical keyboard", "Apple Magic Keyboard",
                   "laptop trackpad", "webcam", "drawing tablet", "stylus pen", "Apple Pencil", "stream deck"],
    "audio":      ["AirPods earbuds", "wireless earbuds", "over-ear headphones", "gaming headset",
                   "Bluetooth speaker", "studio monitor speaker", "podcast microphone", "lavalier microphone"],
    "camera":     ["digital camera", "DSLR camera", "mirrorless camera", "GoPro action camera", "camera lens", "ring light"],
    "wearable":   ["Apple Watch", "Garmin smartwatch", "fitness tracker", "VR headset", "Meta Quest"],
    "gaming":     ["PlayStation controller", "Xbox controller", "Nintendo Switch", "Steam Deck console",
                   "gaming console", "vr controllers"],
    "networking": ["wifi router", "network switch", "NAS server"],
    "storage":    ["USB flash drive", "external hard drive", "portable SSD", "USB-C hub", "SD card", "SD card reader"],
    "smart_home": ["smart speaker", "Amazon Echo", "Google Nest Hub", "smart thermostat", "smart bulb",
                   "security camera", "video doorbell"],
    "power":      ["power bank", "wireless charging pad", "MagSafe charger", "laptop power brick",
                   "power strip", "surge protector", "USB-C cable", "HDMI cable"],
    "maker":      ["Raspberry Pi", "Arduino board", "soldering iron", "multimeter", "3D printer",
                   "drone", "calculator", "laser pointer"],
}

for cat, classes in _cat_map.items():
    for cls in classes:
        CLASS_CATEGORY[cls] = cat


def _category_color(class_name: str):
    cat = CLASS_CATEGORY.get(class_name, "other")
    return CATEGORY_COLORS[cat]


# Classes we should NOT search for on Google Shopping
IGNORE_SEARCH_CLASSES = {
    "person", "cat", "dog", "bird", "horse", "sheep",
    "cow", "elephant", "bear", "zebra", "giraffe",
}

# ── YOLO colour palette ───────────────────────────────────────────────────────
_PALETTE = [
    (56, 56, 255), (151, 157, 255), (31, 112, 255), (29, 178, 255),
    (49, 210, 207), (10, 249, 72),  (23, 204, 146), (134, 219, 61),
    (52, 147, 26),  (187, 212, 0),  (168, 153, 44), (255, 194, 0),
    (147, 69, 52),  (255, 115, 100),(236, 24, 0),   (255, 56, 132),
    (133, 0, 82),   (255, 56, 203), (200, 149, 255),(199, 55, 255),
]

def _class_color(class_id: int):
    return _PALETTE[class_id % len(_PALETTE)]


# ── Product search helpers ────────────────────────────────────────────────────

def _search_product(query: str) -> dict:
    """Return {'price': str} via SerpAPI Google Shopping."""
    if SERPAPI_KEY:
        params = urllib.parse.urlencode({
            "engine": "google_shopping",
            "q": query,
            "api_key": SERPAPI_KEY,
            "num": 1,
        })
        api_url = f"https://serpapi.com/search?{params}"
        try:
            req = urllib.request.Request(api_url,
                                         headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read().decode())
            items = data.get("shopping_results", [])
            if items:
                price = items[0].get("price", "Price N/A")
                return {"price": price}
        except Exception as exc:
            print(f"[ProductSearch] SerpAPI error: {exc}")

    return {"price": "Price N/A"}


# ── Ollama text query ─────────────────────────────────────────────────────────

def _query_ollama_text(class_name: str) -> str | None:
    """Ask Ollama text model for a short, fun fact about the detected object."""
    try:
        prompt = (
            f"Tell me one surprising, weird, or funny fact about a "
            f"'{class_name}' in one short sentence (max 15 words). "
            f"Be playful, not corporate. No preamble, just the fact."
        )
        payload = json.dumps({
            "model":  OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
        }).encode("utf-8")
        req = urllib.request.Request(
            OLLAMA_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as resp:
            data = json.loads(resp.read().decode())
        text = (data.get("response") or "").strip()
        text = text.strip(" .\n\"'")
        return text or None
    except Exception as exc:
        print(f"[Ollama] text query failed: {exc}")
        return None


def _query_moondream(image_bgr, prompt: str) -> str | None:
    """Send a BGR image crop to moondream vision model with a custom prompt."""
    try:
        ok, buf = cv2.imencode(".jpg", image_bgr, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok:
            return None
        b64 = base64.b64encode(buf.tobytes()).decode("ascii")
        payload = json.dumps({
            "model":  OLLAMA_VISION_MODEL,
            "prompt": prompt,
            "images": [b64],
            "stream": False,
        }).encode("utf-8")
        req = urllib.request.Request(
            OLLAMA_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=OLLAMA_VISION_TIMEOUT) as resp:
            data = json.loads(resp.read().decode())
        text = (data.get("response") or "").strip()
        return text or None
    except Exception as exc:
        print(f"[Moondream] query failed: {exc}")
        return None


def _generate_personalized_greeting(profile: dict, time_since: str) -> str | None:
    """Use Ollama to craft a personalised greeting based on profile + history."""
    try:
        facts = "; ".join(profile.get("facts", [])) or "no notes"
        meetings = profile.get("meeting_count", 1)
        prompt = (
            f"Greet a person named {profile['name']} in ONE short, warm, "
            f"playful sentence. Facts about them: {facts}. "
            f"You last saw them {time_since}. This is meeting #{meetings}. "
            f"Be natural and personal, like an old friend. "
            f"No preamble, no quotes, just the greeting (max 18 words)."
        )
        payload = json.dumps({
            "model":  OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
        }).encode("utf-8")
        req = urllib.request.Request(
            OLLAMA_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as resp:
            data = json.loads(resp.read().decode())
        text = (data.get("response") or "").strip().strip('"\'')
        return text or None
    except Exception as exc:
        print(f"[Greet] generation failed: {exc}")
        return None


def _translate_to_finnish(text: str) -> str | None:
    """Translate English text to Finnish using the text model."""
    try:
        prompt = (
            f"Translate this English text to Finnish. Reply only with the "
            f"Finnish translation, no preamble:\n\n{text}"
        )
        payload = json.dumps({
            "model":  OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
        }).encode("utf-8")
        req = urllib.request.Request(
            OLLAMA_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as resp:
            data = json.loads(resp.read().decode())
        return (data.get("response") or "").strip() or None
    except Exception as exc:
        print(f"[Translate] failed: {exc}")
        return None


# ── OpenCV face detector (Haar – no extra deps) ───────────────────────────────

def _make_face_detector():
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    detector = cv2.CascadeClassifier(cascade_path)
    if detector.empty():
        print("[FaceDetect] WARNING: Haar cascade not found – face detection disabled.")
        return None
    return detector


def _make_eye_detector():
    path = cv2.data.haarcascades + "haarcascade_eye.xml"
    det = cv2.CascadeClassifier(path)
    return det if not det.empty() else None


def _make_profile_detector():
    path = cv2.data.haarcascades + "haarcascade_profileface.xml"
    det = cv2.CascadeClassifier(path)
    return det if not det.empty() else None


# ─────────────────────────────────────────────────────────────────────────────
# ██████████████████   CONFIGURE YOUR PEOPLE HERE   ██████████████████████████
# ─────────────────────────────────────────────────────────────────────────────
#
#  Add one entry per person.  photo_path can be absolute or relative to the
#  working directory where you launch main.py.
#
#  Example:
#       {"name": "Alice Smith",  "age": 29, "role": "Engineer",
#        "photo_path": "photos/alice.jpg"},
#
PEOPLE_REGISTRY: list[dict] = [
    # Add entries here, e.g.:
    # {"name": "Faisal", "age": 22, "role": "Student",
    #      "photo_path": r"C:\Users\super\Pictures\faisal.jpg"},
    # ← ADD YOUR ENTRIES HERE ↓
    # {"name": "Alice Smith",   "age": 29, "role": "Engineer",    "photo_path": "photos/alice.jpg"},
    # {"name": "Bob Johnson",   "age": 45, "role": "Businessman", "photo_path": "photos/bob.jpg"},
    # {"name": "Carol White",   "age": 22, "role": "Student",     "photo_path": "photos/carol.jpg"},
    # ← ADD YOUR ENTRIES HERE ↑
]
# ─────────────────────────────────────────────────────────────────────────────

# ── Cognitive Load Tracker ────────────────────────────────────────────────────
#
#  READ-ONLY observer of eye signals.  Never writes to shared_data["eyeEvent"]
#  so it won't collide with double-blink detection or any other event consumer.
#
 
class CognitiveLoadTracker:
    """
    Produces a 0–100 cognitive load score from three signals:
      • pupil dilation vs personal baseline   (weight 0.45)
      • blink rate  (low = focused/overloaded) (weight 0.25)
      • fixation duration  (long = deep processing) (weight 0.30)
 
    All signals are observed passively — nothing is consumed or modified.
    """
 
    def __init__(self):
        self._pupil_history   = collections.deque()   # (timestamp, avg_pupil)
        self._blink_times     = collections.deque()   # timestamps of detected blinks
        self._fixation_durs   = collections.deque()   # (timestamp, duration_estimate)
 
        self._baseline_pupil  = None
        self._baseline_locked = False
        self._start_time      = None
 
        # Track event transitions (read-only) to count blinks
        self._last_event      = ""
        self._fixation_start  = None
 
        # Output
        self.score            = 0       # 0 = relaxed, 100 = overloaded
        self.level            = "calm"  # "calm" | "focused" | "high"
        self._last_calc       = 0
 
    def update(self, pupil_avg: float, eye_event: str, now: float):
        """Call every frame. Reads pupil + event, never writes to shared_data."""
        if self._start_time is None:
            self._start_time = now
 
        # ── Record pupil ──────────────────────────────────────────────────────
        if pupil_avg > 0:
            self._pupil_history.append((now, pupil_avg))
 
        # ── Detect blink transitions (READ-ONLY on eye_event) ─────────────────
        #    "BB" = blink begin.  We count the transition INTO BB, not BB itself,
        #    so repeated BB frames don't double-count.
        if eye_event == "BB" and self._last_event != "BB":
            self._blink_times.append(now)
        self._last_event = eye_event
 
        # ── Fixation duration tracking ────────────────────────────────────────
        if eye_event == "FB":
            if self._fixation_start is None:
                self._fixation_start = now
        else:
            if self._fixation_start is not None:
                dur = now - self._fixation_start
                if dur > 0.05:  # ignore micro-fixations
                    self._fixation_durs.append((now, dur))
                self._fixation_start = None
 
        # ── Trim old data outside the rolling window ──────────────────────────
        cutoff = now - CLT_WINDOW_SEC
        while self._pupil_history and self._pupil_history[0][0] < cutoff:
            self._pupil_history.popleft()
        while self._blink_times and self._blink_times[0] < cutoff:
            self._blink_times.popleft()
        while self._fixation_durs and self._fixation_durs[0][0] < cutoff:
            self._fixation_durs.popleft()
 
        # ── Learn baseline pupil from first N seconds ─────────────────────────
        if not self._baseline_locked:
            elapsed = now - self._start_time
            if elapsed >= CLT_PUPIL_BASELINE_SEC and len(self._pupil_history) > 10:
                vals = [v for _, v in self._pupil_history]
                self._baseline_pupil = sum(vals) / len(vals)
                self._baseline_locked = True
                print(f"[CogLoad] Baseline pupil locked: {self._baseline_pupil:.2f}")
 
        # ── Recalculate score (throttled) ─────────────────────────────────────
        if now - self._last_calc < CLT_UPDATE_INTERVAL:
            return
        self._last_calc = now
        self._calc_score(now)
 
    def _calc_score(self, now: float):
        # --- Pupil component (0–100) ---
        pupil_score = 50  # neutral until baseline is ready
        if self._baseline_pupil and self._baseline_pupil > 0 and self._pupil_history:
            recent = [v for _, v in self._pupil_history]
            avg    = sum(recent) / len(recent)
            # +20% dilation → score 100,  −10% constriction → score 0
            ratio  = (avg - self._baseline_pupil) / self._baseline_pupil
            pupil_score = max(0, min(100, 50 + ratio * 250))
 
        # --- Blink rate component (0–100) ---
        blink_score = 50
        window_len  = min(CLT_WINDOW_SEC, (now - self._start_time) if self._start_time else 1)
        if window_len > 3:
            blinks_per_min = len(self._blink_times) / window_len * 60
            # Normal: ~15–20 blinks/min.  <8 = deep focus/overload, >25 = fatigue
            if blinks_per_min < 8:
                blink_score = 80 + min(20, (8 - blinks_per_min) * 3)
            elif blinks_per_min > 25:
                blink_score = 70 + min(30, (blinks_per_min - 25) * 2)
            else:
                blink_score = max(0, 50 - (blinks_per_min - 8) * 3)
 
        # --- Fixation duration component (0–100) ---
        fix_score = 50
        if self._fixation_durs:
            durations = [d for _, d in self._fixation_durs]
            avg_dur   = sum(durations) / len(durations)
            # >600 ms avg fixation = heavy processing, <200 ms = scanning
            fix_score = max(0, min(100, (avg_dur - 0.2) / 0.5 * 100))
 
        # --- Weighted blend ---
        self.score = int(
            pupil_score * 0.45 +
            blink_score * 0.25 +
            fix_score   * 0.30
        )
        self.score = max(0, min(100, self.score))
 
        if self.score < 35:
            self.level = "calm"
        elif self.score < 65:
            self.level = "focused"
        else:
            self.level = "high"
 
 
def _draw_cognitive_bar(frame, tracker: CognitiveLoadTracker):
    """Draw a small cognitive load meter in the top-right corner."""
    score = tracker.score
    level = tracker.level
 
    bar_w, bar_h = 120, 16
    margin = 10
    x1 = frame.shape[1] - bar_w - margin
    y1 = margin
    x2 = x1 + bar_w
    y2 = y1 + bar_h
 
    # Background
    overlay = frame.copy()
    cv2.rectangle(overlay, (x1 - 2, y1 - 20), (x2 + 2, y2 + 2), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.5, frame, 0.5, 0, frame)
 
    # Colour: green → yellow → red
    if score < 35:
        color = (80, 200, 80)     # green
    elif score < 65:
        color = (0, 200, 255)     # yellow
    else:
        color = (50, 50, 230)     # red
 
    # Filled portion
    fill_w = int(bar_w * score / 100)
    cv2.rectangle(frame, (x1, y1), (x1 + fill_w, y2), color, -1)
    # Border
    cv2.rectangle(frame, (x1, y1), (x2, y2), (200, 200, 200), 1)
 
    # Label
    label = f"Load: {score}%  ({level})"
    cv2.putText(frame, label, (x1, y1 - 5),
                cv2.FONT_HERSHEY_SIMPLEX, 0.38, (200, 200, 200), 1, cv2.LINE_AA)
 

# ── Main class ────────────────────────────────────────────────────────────────

class process:
    def __init__(self, shared_data, image_buffer_scene):
        print("enter main")
        self.shared_data        = shared_data
        self.image_buffer_scene = image_buffer_scene

        # Gaze smoothing
        self.gazeX_history = collections.deque(maxlen=10)
        self.gazeY_history = collections.deque(maxlen=10)

        # Eye event state
        self.current_event = "NA"

        # Dwell & Pupil state
        self.dwell_start_time = None
        self.dwell_anchor     = None
        self.baseline_pupil   = None

        # Active highlight overlays
        self.active_highlights = []
        self._lock             = threading.Lock()

         # ── Cognitive load tracker (read-only observer) ───────────────────────
        self.cog_tracker = CognitiveLoadTracker()

        # ── Text-to-speech engine ─────────────────────────────────────────────
        self.speech = (SpeechEngine(rate=TTS_RATE, dedup_window=TTS_DEDUP_WINDOW)
                       if TTS_ENABLED else None)

        # ── Voice input (microphone) ──────────────────────────────────────────
        self.listener = Listener(language="en-US")

        # ── Per-person profiles (meetings, facts, history) ────────────────────
        self.profiles = ProfileStore()
        self._greeted_recently: dict[str, float] = {}  # name -> last greet ts

        # Cooldown so we don't ask the same unknown face every dwell
        self._last_unknown_ask = 0.0
        self._asking_name      = False
        self._listening        = False   # True while microphone is recording

        # Continuous face tracking state
        self._face_check_every  = 2         # run detector every N frames (faster)
        self._frame_counter     = 0
        self._unknown_seen_at   = None      # timestamp first Unknown seen
        self._last_known_face   = None      # last identified profile dict
        self._UNKNOWN_REGISTER_AFTER = 1.0  # seconds of unknown → ask name

        # Cached face box for lightweight overlay (no name/age/role text)
        self._current_face_box = None
        self._current_face_box_until = 0.0

        # ── Attractiveness meter (pupil dilation while looking at a face) ─────
        self._attr_baseline_buf = collections.deque(maxlen=80)  # ~last 10 s pupils
        self._attr_face_started = None    # when current "looking at face" began
        self._attr_baseline     = None    # pupil baseline frozen at face onset
        self._attr_during_buf   = []      # pupil samples while looking at face
        self._attr_cooldown_to  = 0.0     # don't re-score until this timestamp
        self._attr_last_score   = None    # latest score for overlay (text, score)
        self._attr_score_shown_until = 0.0
        self._ATTR_MEASURE_SECONDS = 2.0
        self._ATTR_COOLDOWN        = 15.0

        # ── Person database ───────────────────────────────────────────────────
        print("Loading person database…")
        self.person_db     = PersonDatabase()
        self.face_detector    = _make_face_detector()
        self.eye_detector     = _make_eye_detector()
        self.profile_detector = _make_profile_detector()

        if PEOPLE_REGISTRY:
            self.person_db.register_many(PEOPLE_REGISTRY)

        # Auto-load any saved faces — group <name>.jpg + <name>_2.jpg etc.
        import os, glob, re
        if os.path.isdir("registered_faces"):
            grouped: dict[str, list] = {}
            for path in sorted(glob.glob("registered_faces/*.jpg")):
                base = os.path.splitext(os.path.basename(path))[0]
                # Strip "_N" suffix to group multi-captures under one name
                root = re.sub(r"_\d+$", "", base)
                img = cv2.imread(path)
                if img is not None:
                    grouped.setdefault(root, []).append(img)
            for name, imgs in grouped.items():
                self.person_db._backend.add_person_multi(name, 0, "Friend", imgs)
                self.person_db._count += 1
                print(f"[Autoload] Restored '{name}' ({len(imgs)} image(s))")

        if self.person_db.size:
            print(f"Person database ready: {self.person_db.size} person(s) registered.")
        else:
            print("Person database empty – press N while looking at a face to add one.")

        # YOLO object detection removed — face-only mode.
        self.yolo = None

    # ── Gaze helpers ─────────────────────────────────────────────────────────

    def get_filtered_gaze(self):
        rawX = self.shared_data["GazeX"].value * VGA_W
        rawY = self.shared_data["GazeY"].value * VGA_H
        if rawX != 0 or rawY != 0:
            self.gazeX_history.append(rawX)
            self.gazeY_history.append(rawY)
        if not self.gazeX_history:
            return 0, 0
        return (int(sum(self.gazeX_history) / len(self.gazeX_history)),
                int(sum(self.gazeY_history) / len(self.gazeY_history)))

    @staticmethod
    def _dist(p1, p2):
        return ((p1[0]-p2[0])**2 + (p1[1]-p2[1])**2) ** 0.5

    # ── Face detection & identification ───────────────────────────────────────

    def _find_face_near_gaze(self, frame: "np.ndarray", gaze_x: int, gaze_y: int):
        """
        Robust face detection — tries frontal + profile + flipped profile,
        validates with eyes when possible but accepts large frontal faces
        even without eye confirmation. Returns face closest to gaze.
        """
        if self.face_detector is None:
            return None

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        gray_eq = clahe.apply(gray)

        all_faces = []

        # Frontal — relaxed
        for (fx, fy, fw, fh) in self.face_detector.detectMultiScale(
                gray_eq, scaleFactor=1.1, minNeighbors=4,
                minSize=(40, 40), flags=cv2.CASCADE_SCALE_IMAGE):
            all_faces.append((fx, fy, fw, fh, "frontal"))

        # Profile (right-facing)
        if self.profile_detector is not None:
            for (fx, fy, fw, fh) in self.profile_detector.detectMultiScale(
                    gray_eq, scaleFactor=1.1, minNeighbors=4, minSize=(40, 40)):
                all_faces.append((fx, fy, fw, fh, "profile"))
            # Profile (left-facing) by flipping image
            flipped = cv2.flip(gray_eq, 1)
            for (fx, fy, fw, fh) in self.profile_detector.detectMultiScale(
                    flipped, scaleFactor=1.1, minNeighbors=4, minSize=(40, 40)):
                all_faces.append((flipped.shape[1] - fx - fw, fy, fw, fh, "profile_l"))

        if not all_faces:
            return None

        # Pick face closest to gaze
        all_faces.sort(key=lambda f: self._dist(
            (gaze_x, gaze_y), (f[0] + f[2]//2, f[1] + f[3]//2)))

        # For frontal faces large enough, accept directly. For small or profile,
        # require an eye for confirmation (cuts random patterns/clothes).
        for fx, fy, fw, fh, kind in all_faces:
            if kind == "frontal" and fw >= 70:
                return (fx, fy, fx + fw, fy + fh)
            if self.eye_detector is not None:
                roi = gray_eq[fy:fy + fh//2 + 5, fx:fx + fw]
                if roi.size > 0:
                    eyes = self.eye_detector.detectMultiScale(
                        roi, scaleFactor=1.1, minNeighbors=3,
                        minSize=(max(6, fw//14), max(6, fh//18)),
                    )
                    if len(eyes) >= 1:
                        return (fx, fy, fx + fw, fy + fh)
            else:
                return (fx, fy, fx + fw, fy + fh)
        return None

    def _identify_person(self, frame: "np.ndarray", box) -> dict | None:
        """
        Crop the face region from frame and run recognition.
        Uses a generous padding so the recogniser always sees the full face.
        Returns person dict or None.
        """
        x1, y1, x2, y2 = box
        face_w = x2 - x1
        face_h = y2 - y1
        # Dynamic padding: 25% of face size so forehead/chin are included
        pad_x = int(face_w * 0.25)
        pad_y = int(face_h * 0.25)
        fh, fw = frame.shape[:2]
        x1c = max(0, x1 - pad_x)
        y1c = max(0, y1 - pad_y)
        x2c = min(fw, x2 + pad_x)
        y2c = min(fh, y2 + pad_y)
        face_crop = frame[y1c:y2c, x1c:x2c]
        return self.person_db.identify(face_crop)

    # ── Hotkey vision actions (R = read text, T = translate) ─────────────────

    def _crop_gaze_region(self, frame, gaze_x: int, gaze_y: int):
        fh, fw = frame.shape[:2]
        r = VISION_CROP_RADIUS
        x1 = max(0, gaze_x - r); y1 = max(0, gaze_y - r)
        x2 = min(fw, gaze_x + r); y2 = min(fh, gaze_y + r)
        if x2 - x1 < 20 or y2 - y1 < 20:
            return None
        return frame[y1:y2, x1:x2]

    def _action_read_text(self, gaze_x: int, gaze_y: int):
        """R-key: OCR the gaze region with moondream and speak it."""
        def _worker():
            crop = self._crop_gaze_region(self.image_buffer_scene.copy(),
                                           gaze_x, gaze_y)
            if crop is None:
                return
            if self.speech: self.speech.speak("Reading.")
            text = _query_moondream(
                crop,
                "Read aloud any text visible in this image. "
                "Reply with only the text, nothing else. "
                "If no text is visible, reply 'No text found'."
            )
            if text:
                print(f"[Read] {text}")
                if self.speech: self.speech.speak(text)
            else:
                if self.speech: self.speech.speak("Could not read.")
        threading.Thread(target=_worker, daemon=True).start()

    def _action_translate(self, gaze_x: int, gaze_y: int):
        """T-key: OCR + translate to Finnish, then speak."""
        def _worker():
            crop = self._crop_gaze_region(self.image_buffer_scene.copy(),
                                           gaze_x, gaze_y)
            if crop is None:
                return
            if self.speech: self.speech.speak("Translating.")
            text = _query_moondream(
                crop,
                "Read aloud any text visible in this image. "
                "Reply with only the text, nothing else."
            )
            if not text or "no text" in text.lower():
                if self.speech: self.speech.speak("No text found.")
                return
            print(f"[Translate] EN: {text}")
            fi = _translate_to_finnish(text)
            if fi:
                print(f"[Translate] FI: {fi}")
                if self.speech: self.speech.speak(fi)
        threading.Thread(target=_worker, daemon=True).start()

    def _score_attractiveness(self, pupil_ratio: float, fixation_pct: float,
                               blink_count: int) -> int:
        """
        Combine three signals into a 1–10 attractiveness score:
          • pupil_ratio  : how much pupil dilated vs baseline (-0.10 .. +0.20+)
          • fixation_pct : fraction of measurement window where gaze was on face
          • blink_count  : number of blinks during the window (lower = more focused)
        """
        # Pupil component (0–100)
        if pupil_ratio < -0.05:    pupil_s = 0
        elif pupil_ratio < 0:      pupil_s = 30 + pupil_ratio * 600    # -0.05..0 → 0..30
        elif pupil_ratio < 0.20:   pupil_s = 30 + pupil_ratio * 350    # 0..0.20 → 30..100
        else:                      pupil_s = 100

        # Fixation component (0–100): >=80% time on face = full score
        fix_s = max(0, min(100, fixation_pct * 125))

        # Blink suppression component (0–100): 0 blinks=100, 1=70, 2=40, 3+=20
        blink_s = {0: 100, 1: 70, 2: 40}.get(blink_count, 20)

        # Weighted blend: pupil 55%, fixation 30%, blinks 15%
        composite = pupil_s * 0.55 + fix_s * 0.30 + blink_s * 0.15

        # Map composite (0–100) → 1–10 (ensure range)
        score = int(round(composite / 10))
        return max(1, min(10, score))

    def _attractiveness_comment(self, score: int) -> str:
        """Generate a cheeky one-liner via Ollama based on score."""
        try:
            prompt = (
                f"You are a flirty wingman AI judging someone's attractiveness "
                f"on a 1-to-10 scale based on the user's pupil dilation while "
                f"they look at a person. The score is {score} out of 10. "
                f"Reply with ONE short, playful, cheeky sentence (max 18 words) "
                f"announcing the score. No preamble, no quotes."
            )
            payload = json.dumps({
                "model":  OLLAMA_MODEL,
                "prompt": prompt,
                "stream": False,
            }).encode("utf-8")
            req = urllib.request.Request(
                OLLAMA_URL, data=payload,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as resp:
                data = json.loads(resp.read().decode())
            return (data.get("response") or "").strip().strip('"\'') \
                   or f"I'd say a {score} out of 10."
        except Exception as exc:
            print(f"[Attr] comment failed: {exc}")
            return f"That's a {score} out of 10."

    def _attr_announce(self, score: int):
        def _worker():
            line = self._attractiveness_comment(score)
            print(f"[Attr] score={score}/10  → {line}")
            self._attr_last_score = (line, score)
            self._attr_score_shown_until = time.time() + 8.0
            if self.speech: self.speech.speak(line)
        threading.Thread(target=_worker, daemon=True).start()

    def _update_attractiveness(self, now: float, current_pupil: float,
                               face_detected: bool):
        """Score pupil + fixation + blink signals while looking at face."""
        if current_pupil > 0:
            self._attr_baseline_buf.append(current_pupil)

        if face_detected:
            if self._attr_face_started is None:
                if len(self._attr_baseline_buf) >= 10 and now > self._attr_cooldown_to:
                    self._attr_baseline = sum(self._attr_baseline_buf) / \
                                           len(self._attr_baseline_buf)
                    self._attr_face_started = now
                    self._attr_during_buf   = []
                    self._attr_face_frames  = 0      # frames where face is under gaze
                    self._attr_total_frames = 0      # total frames in window
                    self._attr_blinks       = 0
                    self._attr_last_event   = self.current_event
                    print(f"[Attr] start — baseline pupil {self._attr_baseline:.2f}")
            # Sample
            if current_pupil > 0:
                self._attr_during_buf.append(current_pupil)
            self._attr_face_frames  += 1
            self._attr_total_frames += 1
            # Count blink transitions
            if self.current_event == "BB" and self._attr_last_event != "BB":
                self._attr_blinks += 1
            self._attr_last_event = self.current_event
        else:
            if self._attr_face_started is not None:
                self._attr_total_frames += 1   # gaze drifted off — count for fixation%
                if self.current_event == "BB" and self._attr_last_event != "BB":
                    self._attr_blinks += 1
                self._attr_last_event = self.current_event

        # Time to score?
        if self._attr_face_started is not None \
                and now - self._attr_face_started >= self._ATTR_MEASURE_SECONDS \
                and len(self._attr_during_buf) >= 5:
            avg   = sum(self._attr_during_buf) / len(self._attr_during_buf)
            ratio = (avg - self._attr_baseline) / self._attr_baseline \
                    if self._attr_baseline else 0.0
            fix_pct = (self._attr_face_frames / self._attr_total_frames
                       if self._attr_total_frames else 0.0)
            score = self._score_attractiveness(ratio, fix_pct, self._attr_blinks)
            print(f"[Attr] pupil {ratio*100:+.1f}%  fixation {fix_pct*100:.0f}%"
                  f"  blinks {self._attr_blinks}  → {score}/10")
            self._attr_announce(score)
            self._attr_cooldown_to  = now + self._ATTR_COOLDOWN
            self._attr_face_started = None
            self._attr_during_buf   = []

    def _greet_person_async(self, name: str):
        """Generate a personalised greeting via Ollama and speak it."""
        # Don't spam — at most one greeting per person per 60 s
        last = self._greeted_recently.get(name, 0)
        if time.time() - last < 60.0:
            return
        self._greeted_recently[name] = time.time()

        def _worker():
            profile = self.profiles.record_meeting(name)
            if profile is None:
                # No profile yet (legacy face) — create one on first sighting
                self.profiles.add(name)
                profile = self.profiles.get(name)
            time_since = "just now" if profile["meeting_count"] == 1 else \
                         self.profiles.time_since(profile)
            print(f"[Greet] {name} — meeting #{profile['meeting_count']}, "
                  f"facts: {profile.get('facts', [])}")
            greeting = _generate_personalized_greeting(profile, time_since)
            if greeting:
                print(f"[Greet] → {greeting}")
                if self.speech: self.speech.speak(greeting)
            else:
                if self.speech: self.speech.speak(f"Hey {name}!")
        threading.Thread(target=_worker, daemon=True).start()

    def _action_remember_face(self, gaze_x: int, gaze_y: int):
        """Auto: ask name (voice), capture face, register."""
        if self._asking_name:
            return
        def _worker():
            import os
            self._asking_name = True
            try:
                snap = self.image_buffer_scene.copy()
                face_box = self._find_face_near_gaze(snap, gaze_x, gaze_y)
                if face_box is None:
                    print("[Remember] No face found near gaze.")
                    return

                def _crop(frame, box):
                    x1, y1, x2, y2 = box
                    pad_x = int((x2 - x1) * 0.4)
                    pad_y = int((y2 - y1) * 0.4)
                    fh, fw = frame.shape[:2]
                    return frame[max(0, y1-pad_y):min(fh, y2+pad_y),
                                 max(0, x1-pad_x):min(fw, x2+pad_x)]

                crops = [_crop(snap, face_box)]
                print(f"[Remember] Capture 1/6 ({crops[0].shape})")
                if self.speech: self.speech.speak("Hold still for a second.")
                # Capture 5 more frames over ~3 seconds — different angles/blinks
                for i in range(5):
                    time.sleep(0.6)
                    f = self.image_buffer_scene.copy()
                    box = self._find_face_near_gaze(f, gaze_x, gaze_y)
                    if box is not None:
                        crops.append(_crop(f, box))
                        print(f"[Remember] Capture {len(crops)}/6")
                print(f"[Remember] Got {len(crops)} face captures total.")

                if self.speech:
                    self.speech.speak("Hi there! What is your name?")
                time.sleep(3.0)  # let TTS finish before we start mic

                name = None
                if self.listener and self.listener._enabled:
                    for attempt in (1, 2, 3):
                        print(f"[Remember] Listening attempt {attempt}/3 (8s)…")
                        self._listening = True
                        try:
                            heard = self.listener.listen_once(timeout=8.0,
                                                              phrase_limit=5.0)
                        finally:
                            self._listening = False
                        if heard:
                            name = heard
                            break
                        if attempt < 3 and self.speech:
                            self.speech.speak("I didn't hear you. Please say your name.")
                            time.sleep(2.5)
                else:
                    print("[Remember] Listener not enabled — skipping registration.")
                    return

                if not name:
                    print("[Remember] Gave up after 3 attempts.")
                    if self.speech:
                        self.speech.speak("I couldn't hear you. Maybe next time.")
                    return

                # Clean up name: take first 1-2 words, strip filler words
                stop = {"my", "name", "is", "i", "am", "i'm", "the", "a", "this"}
                words = [w for w in name.split() if w.lower() not in stop]
                if not words:
                    words = name.split()
                name = " ".join(words[:2]).title()
                print(f"[Remember] Parsed name: '{name}'")

                # Confirm by speaking it back
                if self.speech:
                    self.speech.speak(f"Nice to meet you, {name}!")
                time.sleep(2.0)

                # Ask one fun fact about them
                fact = ""
                if self.speech:
                    self.speech.speak("Tell me one thing about yourself.")
                time.sleep(2.5)
                if self.listener and self.listener._enabled:
                    print("[Remember] Listening for a fact (10s)…")
                    self._listening = True
                    try:
                        fact = self.listener.listen_once(timeout=10.0,
                                                         phrase_limit=8.0) or ""
                    finally:
                        self._listening = False
                    print(f"[Remember] Fact heard: '{fact}'")

                os.makedirs("registered_faces", exist_ok=True)
                safe = "".join(c for c in name if c.isalnum() or c in "-_ ").strip()
                # Save the best (first) crop as the main photo
                path = os.path.join("registered_faces", f"{safe}.jpg")
                cv2.imwrite(path, crops[0])
                # Save additional captures with suffix
                for i, c in enumerate(crops[1:], start=2):
                    cv2.imwrite(
                        os.path.join("registered_faces", f"{safe}_{i}.jpg"), c
                    )
                print(f"[Remember] Saved {len(crops)} face image(s) → {path}*")

                ok = self.person_db._backend.add_person_multi(
                    name, 0, "Friend", crops
                )
                if ok:
                    self.person_db._count += 1
                    self.profiles.add(name, fact)
                    print(f"[Remember] ✓ Registered '{name}'. Total: {self.person_db.size}")
                    if self.speech:
                        if fact:
                            self.speech.speak(f"Got it. I'll remember that.")
                        else:
                            self.speech.speak("Okay, I'll remember you.")
                else:
                    print(f"[Remember] ✗ Backend failed to register '{name}'.")
                    if self.speech:
                        self.speech.speak("Sorry, I couldn't remember that face.")
            finally:
                self._asking_name = False
                self._last_unknown_ask = time.time()
        threading.Thread(target=_worker, daemon=True).start()

    def _action_describe_scene(self, gaze_x: int, gaze_y: int):
        """D-key: ask moondream to describe what user is looking at."""
        def _worker():
            crop = self._crop_gaze_region(self.image_buffer_scene.copy(),
                                           gaze_x, gaze_y)
            if crop is None:
                return
            if self.speech: self.speech.speak("Looking.")
            text = _query_moondream(
                crop,
                "Describe what you see in one short, vivid sentence. "
                "Be playful and observant, like a curious friend."
            )
            if text:
                print(f"[Describe] {text}")
                if self.speech: self.speech.speak(text)
        threading.Thread(target=_worker, daemon=True).start()

    # ── Ollama description fetch (background) ────────────────────────────────

    def _fetch_description_async(self, highlight: dict):
        def _worker():
            desc = _query_ollama_text(highlight["class_name"])
            if desc:
                with self._lock:
                    highlight["description"] = desc
                print(f"[Ollama] '{highlight['class_name']}' → {desc}")
                if self.speech:
                    self.speech.speak(desc)
        threading.Thread(target=_worker, daemon=True).start()

    # ── YOLO gadget detection ────────────────────────────────────────────────

    def _run_yolo(self, frame, gaze_x, gaze_y):
        results = self.yolo(frame, verbose=False)[0]
        if results.boxes is None or len(results.boxes) == 0:
            return None

        best, best_dist = None, float("inf")
        for box in results.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
            cx, cy = (x1+x2)//2, (y1+y2)//2
            d = self._dist((gaze_x, gaze_y), (cx, cy))
            if d < best_dist:
                best_dist = d
                cls_id   = int(box.cls[0])
                conf     = float(box.conf[0])
                cls_name = self.yolo.names[cls_id]
                best = dict(
                    box           = (x1, y1, x2, y2),
                    label         = f"{cls_name} {conf:.0%}",
                    class_name    = cls_name,
                    color         = _category_color(cls_name),
                    expires_at    = time.time() + HIGHLIGHT_FADE,
                    link_status   = "searching",
                    product_price = "",
                    kind          = "gadget",          # ← tag so draw knows type
                )
        return best

    # ── Face-only detection (triggered by dwell alone) ──────────────────────

    def _run_face_only(self, frame, gaze_x: int, gaze_y: int):
        """
        Runs only face detection + identification.
        Called on every dwell, no pupil change required.
        Returns a highlight dict or None.
        """
        try:
            face_box = self._find_face_near_gaze(frame, gaze_x, gaze_y)
            if face_box is None:
                print("[FaceDetect] No face found near gaze point.")
                return None
            print(f"[FaceDetect] Face box: {face_box}")
            person = self._identify_person(frame, face_box)
            if person:
                color = PERSON_BOX_COLOR
                label = person["name"]
            else:
                color = UNKNOWN_BOX_COLOR
                label = "Unknown person"
                person = {"name": "Unknown", "age": "?", "role": "?"}
            return dict(
                box           = face_box,
                label         = label,
                class_name    = "person",
                color         = color,
                expires_at    = time.time() + HIGHLIGHT_FADE,
                kind          = "person",
                person        = person,
                link_status   = "ignored",
                product_price = "",
            )
        except Exception as e:
            print(f"[FaceDetect] ERROR: {e}")
            import traceback; traceback.print_exc()
            return None

    # ── Gaze-triggered detection: face AND gadget run in parallel ───────────

    def _run_detection(self, frame, gaze_x: int, gaze_y: int) -> dict | None:
        """
        Run face detection and YOLO gadget detection concurrently in threads.
        Both results are scored by distance to gaze; the closer one wins.
        This ensures looking at a person always triggers person ID even when
        a gadget is also present in the scene.
        """
        face_result   = [None]
        gadget_result = [None]

        def _detect_face():
            try:
                face_box = self._find_face_near_gaze(frame, gaze_x, gaze_y)
                if face_box is None:
                    print("[FaceDetect] No face found near gaze point.")
                    return
                print(f"[FaceDetect] Face box found: {face_box}")
                person = self._identify_person(frame, face_box)
                if person:
                    color = PERSON_BOX_COLOR
                    label = person["name"]
                else:
                    color = UNKNOWN_BOX_COLOR
                    label = "Unknown person"
                    person = {"name": "Unknown", "age": "?", "role": "?"}
                face_result[0] = dict(
                    box           = face_box,
                    label         = label,
                    class_name    = "person",
                    color         = _category_color(cls_name),
                    expires_at    = time.time() + HIGHLIGHT_FADE,
                    kind          = "person",
                    person        = person,
                    link_status   = "ignored",
                    product_price = "",
                )
            except Exception as e:
                print(f"[FaceDetect] ERROR in face thread: {e}")
                import traceback; traceback.print_exc()

        def _detect_gadget():
            try:
                gadget_result[0] = self._run_yolo(frame, gaze_x, gaze_y)
            except Exception as e:
                print(f"[FaceDetect] ERROR in gadget thread: {e}")

        t_face   = threading.Thread(target=_detect_face,   daemon=True)
        t_gadget = threading.Thread(target=_detect_gadget, daemon=True)
        t_face.start();   t_gadget.start()
        t_face.join();    t_gadget.join()

        f = face_result[0]
        g = gadget_result[0]

        if f is None and g is None:
            return None
        if f is None:
            return g
        if g is None:
            return f

        # Both found: pick whichever centre is closest to the gaze point
        def _centre_dist(h):
            x1, y1, x2, y2 = h["box"]
            return self._dist((gaze_x, gaze_y), ((x1+x2)//2, (y1+y2)//2))

        return f if _centre_dist(f) <= _centre_dist(g) else g

    # ── Background product fetch ──────────────────────────────────────────────

    def _fetch_link_async(self, highlight: dict):
        def _worker():
            result = _search_product(highlight["class_name"])
            with self._lock:
                highlight["product_price"] = result["price"]
                highlight["link_status"]   = "ready"
            print(f"[ProductSearch] '{highlight['class_name']}' → {result['price']}")
        threading.Thread(target=_worker, daemon=True).start()

    # ── Drawing ──────────────────────────────────────────────────────────────

    def _draw_highlight(self, frame, h: dict):
        """Unified draw for both person and gadget highlights."""
        if h.get("kind") == "person":
            self._draw_person_box(frame, h)
        else:
            self._draw_gadget_box(frame, h)

    def _draw_person_box(self, frame, h: dict):
        """
        Draws the AR-style person identification overlay:

            ┌──────────────────┐
            │ Alice Smith      │   ← name  (large, white)
            │ Age: 29          │   ← age   (medium, light)
            │ Role: Engineer   │   ← role  (medium, light)
            └──────────────────┘
        """
        x1, y1, x2, y2 = h["box"]
        color = h["color"]
        lw    = max(2, int((frame.shape[0]+frame.shape[1]) / 2 * 0.003))

        # ── Corner-bracket style box ──────────────────────────────────────────
        arm = min((x2-x1), (y2-y1)) // 4   # bracket arm length
        pts = [
            # top-left
            [(x1, y1+arm), (x1, y1), (x1+arm, y1)],
            # top-right
            [(x2-arm, y1), (x2, y1), (x2, y1+arm)],
            # bottom-left
            [(x1, y2-arm), (x1, y2), (x1+arm, y2)],
            # bottom-right
            [(x2-arm, y2), (x2, y2), (x2, y2-arm)],
        ]
        for bracket in pts:
            for i in range(len(bracket)-1):
                cv2.line(frame, bracket[i], bracket[i+1], color, lw+1, cv2.LINE_AA)

        # ── Info badge ────────────────────────────────────────────────────────
        person = h["person"]
        name   = person["name"]
        age    = person["age"]
        role   = person["role"]

        line1 = name
        line2 = f"Age: {age}"
        line3 = f"Role: {role}"

        font   = cv2.FONT_HERSHEY_SIMPLEX
        fs1, fs2 = 0.60, 0.48
        thick = 1

        (w1, h1), _ = cv2.getTextSize(line1, font, fs1, thick)
        (w2, h2), _ = cv2.getTextSize(line2, font, fs2, thick)
        (w3, h3), _ = cv2.getTextSize(line3, font, fs2, thick)

        pad     = 6
        badge_w = max(w1, w2, w3) + pad * 2
        badge_h = h1 + h2 + h3 + pad * 4

        # Place badge above the box; clamp to frame edges
        bx1 = x1
        bx2 = min(bx1 + badge_w, frame.shape[1])
        by2 = y1
        by1 = max(0, y1 - badge_h)

        # Semi-transparent filled rectangle
        overlay = frame.copy()
        cv2.rectangle(overlay, (bx1, by1), (bx2, by2), color, -1)
        cv2.addWeighted(overlay, 0.75, frame, 0.25, 0, frame)

        # Text colours
        brightness = 0.299*color[2] + 0.587*color[1] + 0.114*color[0]
        tc      = (0, 0, 0)       if brightness > 160 else (255, 255, 255)
        tc_dim  = (30, 30, 30)    if brightness > 160 else (210, 210, 210)

        y_cursor = by1 + h1 + pad
        cv2.putText(frame, line1, (bx1+pad, y_cursor),
                    font, fs1, tc, thick, cv2.LINE_AA)
        y_cursor += h2 + pad
        cv2.putText(frame, line2, (bx1+pad, y_cursor),
                    font, fs2, tc_dim, thick, cv2.LINE_AA)
        y_cursor += h3 + pad
        cv2.putText(frame, line3, (bx1+pad, y_cursor),
                    font, fs2, tc_dim, thick, cv2.LINE_AA)

    def _draw_gadget_box(self, frame, h: dict):
        """Original product / gadget box drawing (unchanged logic)."""
        x1, y1, x2, y2 = h["box"]
        color = h["color"]
        lw    = max(2, int((frame.shape[0]+frame.shape[1]) / 2 * 0.003))
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, lw)

        font = cv2.FONT_HERSHEY_SIMPLEX
        fs1, fs2 = 0.58, 0.42
        thick = 1

        lines = [h["label"]]
        if h["link_status"] == "searching":
            lines.append("fetching price…")
        elif h["link_status"] != "ignored":
            price = h.get("product_price", "")
            if price:
                lines.append(price)

        # Wrap description (Ollama text model output) to ~32 chars per line
        desc = h.get("description")
        if desc:
            words, cur = desc.split(), ""
            for w in words:
                if len(cur) + len(w) + 1 > 32:
                    if cur: lines.append(cur)
                    cur = w
                else:
                    cur = (cur + " " + w) if cur else w
            if cur: lines.append(cur)
        elif h["link_status"] != "ignored":
            lines.append("…")  # placeholder while Ollama is thinking

        # Measure all lines
        sizes = []
        for i, ln in enumerate(lines):
            fs = fs1 if i == 0 else fs2
            (w, hh), bl = cv2.getTextSize(ln, font, fs, thick)
            sizes.append((w, hh, bl, fs))

        pad     = 5
        badge_w = max(w for w, _, _, _ in sizes) + pad * 2
        badge_h = sum(hh + bl for _, hh, bl, _ in sizes) + pad * (len(lines) + 1)

        by2 = y1
        by1 = max(0, y1 - badge_h)
        bx2 = min(x1 + badge_w, frame.shape[1])

        cv2.rectangle(frame, (x1, by1), (bx2, by2), color, -1)

        brightness = 0.299*color[2] + 0.587*color[1] + 0.114*color[0]
        tc     = (0, 0, 0)     if brightness > 160 else (255, 255, 255)
        tc_dim = tuple(max(0, int(c * 0.6)) for c in tc)

        y_pos = by1 + pad
        for i, (ln, (_, hh, bl, fs)) in enumerate(zip(lines, sizes)):
            y_pos += hh
            col = tc if i == 0 else tc_dim
            cv2.putText(frame, ln, (x1+pad, y_pos), font, fs, col, thick, cv2.LINE_AA)
            y_pos += bl + pad


    # ── Main loop ─────────────────────────────────────────────────────────────

    def run(self):
        print("enter run")
        cv2.namedWindow("Video", cv2.WINDOW_NORMAL)
        cv2.resizeWindow("Video", VGA_W*2, VGA_H*2)

        while not self.shared_data["stop"].value:
            GazeX, GazeY  = self.get_filtered_gaze()
            now            = time.time()
            current_pupil  = (self.shared_data["PupilSizeLeft"].value +
                               self.shared_data["PupilSizeRight"].value) / 2.0

            # ── Eye event ────────────────────────────────────────────────────
            ev = self.shared_data["eyeEvent"].value
            if ev and ev != self.current_event:
                self.current_event = ev

            gaze_color = (0, 0, 255)
            if self.current_event == "FB":
                gaze_color = (0, 255, 0)
            elif self.current_event == "BB":
                gaze_color = (255, 0, 0)


            # ── Cognitive load update (read-only, won't touch eyeEvent) ───────
            self.cog_tracker.update(current_pupil, self.current_event, now)

            # ── Continuous face detection — only for attractiveness scoring ──
            self._frame_counter += 1
            face_under_gaze = False
            if self._frame_counter % self._face_check_every == 0:
                snap = self.image_buffer_scene.copy()
                face_box = self._find_face_near_gaze(snap, GazeX, GazeY)
                if face_box is not None:
                    fx = (face_box[0] + face_box[2]) // 2
                    fy = (face_box[1] + face_box[3]) // 2
                    if self._dist((GazeX, GazeY), (fx, fy)) < 120:
                        face_under_gaze = True
                    self._current_face_box = face_box
                    self._current_face_box_until = now + 0.5
                else:
                    pass

            # Attractiveness scoring (every frame)
            self._update_attractiveness(now, current_pupil, face_under_gaze)

            # Expire old highlights
            with self._lock:
                self.active_highlights = [
                    h for h in self.active_highlights if h["expires_at"] > now
                ]
                snapshot = list(self.active_highlights)

            # ── Draw ──────────────────────────────────────────────────────────
            frame = self.image_buffer_scene.copy()

            # Skip person/highlight overlay entirely — only draw a light face box
            if self._current_face_box and now < self._current_face_box_until:
                x1, y1, x2, y2 = self._current_face_box
                color = (0, 200, 255) if self._attr_face_started else (180, 180, 180)
                cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2, cv2.LINE_AA)

            r = max(int(current_pupil), 4)
            cv2.circle(frame, (GazeX, GazeY), r, gaze_color, 2)

             # ── Cognitive load indicator ──────────────────────────────────────
            _draw_cognitive_bar(frame, self.cog_tracker)

            # ── Attractiveness measurement HUD ───────────────────────────────
            if self._attr_face_started is not None:
                elapsed = now - self._attr_face_started
                pct = min(1.0, elapsed / self._ATTR_MEASURE_SECONDS)
                bar_w, bar_h = 220, 14
                bx, by = 20, frame.shape[0] - 40
                cv2.rectangle(frame, (bx-2, by-2), (bx+bar_w+2, by+bar_h+2),
                              (255, 255, 255), 1)
                cv2.rectangle(frame, (bx, by), (bx + int(bar_w*pct), by+bar_h),
                              (0, 200, 255), -1)
                cv2.putText(frame, "MEASURING ATTRACTION…",
                            (bx, by - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                            (0, 200, 255), 2, cv2.LINE_AA)

            # Show last score for a few seconds, BIG, centred-ish
            if self._attr_last_score and now < self._attr_score_shown_until:
                line, score = self._attr_last_score
                color = (0, 255, 0) if score >= 8 else \
                        (0, 200, 255) if score >= 5 else (0, 80, 255)
                # Big score number top-centre
                txt = f"{score}/10"
                (tw, th), _ = cv2.getTextSize(
                    txt, cv2.FONT_HERSHEY_SIMPLEX, 2.4, 5)
                cx = (frame.shape[1] - tw) // 2
                cv2.putText(frame, txt, (cx, 80),
                            cv2.FONT_HERSHEY_SIMPLEX, 2.4, (0, 0, 0), 8,
                            cv2.LINE_AA)
                cv2.putText(frame, txt, (cx, 80),
                            cv2.FONT_HERSHEY_SIMPLEX, 2.4, color, 4,
                            cv2.LINE_AA)
                # Comment line below (wrap to ~40 chars)
                words, lines, cur = line.split(), [], ""
                for w in words:
                    if len(cur) + len(w) + 1 > 40:
                        lines.append(cur); cur = w
                    else:
                        cur = (cur + " " + w) if cur else w
                if cur: lines.append(cur)
                ly = 110
                for ln in lines:
                    (lw, lh), _ = cv2.getTextSize(
                        ln, cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2)
                    lx = (frame.shape[1] - lw) // 2
                    cv2.putText(frame, ln, (lx, ly),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0,0,0), 4,
                                cv2.LINE_AA)
                    cv2.putText(frame, ln, (lx, ly),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255,255,255), 2,
                                cv2.LINE_AA)
                    ly += lh + 10

            # ── Listening indicator (red pulsing dot + label) ────────────────
            if self._listening:
                pulse = 0.5 + 0.5 * abs((now * 2) % 2 - 1)  # 0..1 triangle
                radius = int(10 + pulse * 6)
                cv2.circle(frame, (24, 30), radius, (0, 0, 255), -1, cv2.LINE_AA)
                cv2.circle(frame, (24, 30), radius, (255, 255, 255), 2, cv2.LINE_AA)
                cv2.putText(frame, "LISTENING…", (44, 38),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6,
                            (0, 0, 255), 2, cv2.LINE_AA)

            cv2.imshow("Video", frame)
            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                self.shared_data["stop"].value = True
                print("Q key pressed. Stopping all processes…")
                break

        cv2.destroyAllWindows()
        print("Process stopped.")