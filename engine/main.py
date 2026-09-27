"""
Veille « Mes reportages »

Examine les nouvelles vidéos de BFM Marseille Provence et BFMTV, calcule
pour chacune un score de ressemblance (nom, visage, voix), télécharge sur
Google Drive celles qui dépassent le seuil, et les classe par année pour
constituer le book.

Signaux :
  nom    : dans le titre / la description / l'article / les sous-titres /
           prononcé en fin de sujet (Whisper)
  visage : comparaison des visages de la vidéo à tes photos de référence
  voix   : comparaison de la voix de la vidéo à tes extraits de référence
"""

import os
import re
import sys
import glob
import json
import shutil
import tempfile
import time
import subprocess
import traceback
import unicodedata
from datetime import datetime, timezone, timedelta
from urllib.parse import urljoin

import numpy as np
import requests
import feedparser
from bs4 import BeautifulSoup
from rapidfuzz import fuzz
from store import Store
import yt_dlp

STORAGE_REPO = os.environ["STORAGE_REPO"]            # ex. HugoDAG/mes-tournages-stockage (privé)
STORAGE_TOKEN = os.environ["STORAGE_TOKEN"]
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:admin@example.com")
GH = {"Authorization": f"Bearer {STORAGE_TOKEN}", "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"}
COOKIES_FILE = os.environ.get("YT_COOKIES_FILE")  # remplacé par le fichier fusionné au démarrage
IG_SESSIONID = os.environ.get("IG_SESSIONID")      # cookie « sessionid » d'un compte Instagram secondaire
IG_USERNAME = os.environ.get("IG_USERNAME")
MAX_TIME_MIN = int(os.environ.get("MAX_RUN_MINUTES", "300"))

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/126 Safari/537.36"}

db = Store(STORAGE_REPO, STORAGE_TOKEN)

DEFAULT_SETTINGS = {
    "name_variants": [], "youtube_channels": ["https://www.youtube.com/@BFM-Marseille", "https://www.youtube.com/@BFMTV"],
    "tiktok_accounts": [], "instagram_accounts": [], "pages": ["https://www.bfmtv.com/marseille/"], "rss_feeds": [],
    "lookback": 200, "max_duration_min": 20, "tail_seconds": 60, "frame_interval": 2, "threshold": 70,
    "whisper_enabled": True, "face_enabled": True, "voice_enabled": True, "max_quality": 2160,
}
START = datetime.now(timezone.utc)


# ============================================================ utilitaires

def log(*a):
    # Les journaux GitHub d'un repo public sont visibles : on n'y écrit
    # jamais le nom recherché ni les scores détaillés.
    print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[^a-z0-9 ]+", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def time_left() -> bool:
    return (datetime.now(timezone.utc) - START).total_seconds() < MAX_TIME_MIN * 60


def find_name(text: str, variants: list[str], fuzzy: bool = False):
    """(score 0-100, extrait) si un des noms est trouvé, sinon None."""
    t = norm(text)
    if not t:
        return None
    for v in variants:
        nv = norm(v)
        if nv and (i := t.find(nv)) >= 0:
            return 100, t[max(0, i - 80): i + len(nv) + 80]
    if fuzzy:
        words = t.split()
        best = None
        for v in variants:
            nv = norm(v)
            n = len(nv.split())
            for k in range(len(words) - n + 1):
                sc = fuzz.ratio(nv, " ".join(words[k:k + n]))
                # « la houze » en 3 mots pour « lahouze » en 2
                sc2 = fuzz.ratio(nv.replace(" ", ""), "".join(words[k:k + n + 1]))
                sc = max(sc, sc2)
                if sc >= 78 and (not best or sc > best[0]):
                    best = (int(sc), " ".join(words[max(0, k - 12): k + n + 12]))
        return best
    return None


def to_pct(sim: float, low: float, high: float) -> int:
    return int(round(100 * min(1.0, max(0.0, (sim - low) / (high - low)))))


def ydl_opts(**extra):
    o = {"quiet": True, "no_warnings": True, "noprogress": True,
         "http_headers": UA, "retries": 3, "socket_timeout": 30,
         # cookies d'un seul compte : on saute la vérification multi-comptes de yt-dlp,
         # et on privilégie les clients YouTube qui marchent avec une session simple
         "extractor_args": {"youtubetab": {"skip": ["authcheck"]},
                            "youtube": {"player_client": ["web", "mweb"]}}}
    if COOKIES_FILE and os.path.exists(COOKIES_FILE) and os.path.getsize(COOKIES_FILE) > 0:
        o["cookiefile"] = COOKIES_FILE
    o.update(extra)
    return o


def build_cookiefile(tmp: str):
    """Fusionne les cookies YouTube et la session Instagram pour yt-dlp."""
    global COOKIES_FILE
    lines = ["# Netscape HTTP Cookie File"]
    if COOKIES_FILE and os.path.exists(COOKIES_FILE):
        with open(COOKIES_FILE, encoding="utf-8", errors="ignore") as f:
            lines += [l.rstrip("\n") for l in f if l.strip() and not l.startswith("# Netscape")]
    if IG_SESSIONID:
        exp = int(datetime.now().timestamp()) + 30 * 86400
        lines.append(f".instagram.com\tTRUE\t/\tTRUE\t{exp}\tsessionid\t{IG_SESSIONID}")
    path = os.path.join(tmp, "cookies.txt")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    COOKIES_FILE = path


def notify(title: str, body: str, url: str = "/"):
    """Notification push vers l'app installée sur l'écran d'accueil."""
    if not VAPID_PRIVATE_KEY:
        return
    from pywebpush import webpush, WebPushException
    subs, _ = db.read("data/push.json", [])
    dead = set()
    for sub in subs:
        try:
            webpush(subscription_info=sub["subscription"],
                    data=json.dumps({"title": title, "body": body, "url": url}),
                    vapid_private_key=VAPID_PRIVATE_KEY,
                    vapid_claims={"sub": VAPID_SUBJECT}, ttl=86400)
        except WebPushException as e:
            if e.response is not None and e.response.status_code in (404, 410):
                dead.add(sub["endpoint"])
            else:
                log("Notification impossible :", str(e)[:120])
        except Exception as e:
            log("Notification impossible :", str(e)[:120])
    if dead:
        db.update("data/push.json", [], lambda l: [x for x in l if x["endpoint"] not in dead],
                  "notifications : abonnements expirés retirés")


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


def safe(s: str) -> str:
    return re.sub(r'[\\/:*?"<>|]+', "-", s or "").strip()[:110]


# ============================================================ collecte

def list_youtube(channel: str, limit: int):
    base = re.sub(r"/(videos|shorts|streams|featured)/?$", "", channel.rstrip("/"))
    for tab in ("videos", "shorts"):
        try:
            with yt_dlp.YoutubeDL(ydl_opts(extract_flat="in_playlist", playlistend=limit)) as y:
                info = y.extract_info(f"{base}/{tab}", download=False)
        except Exception as e:
            if tab == "videos":
                raise
            log("Onglet", tab, "indisponible :", str(e)[:120])
            continue
        for e in info.get("entries") or []:
            if e.get("id"):
                yield {"id": f"youtube:{e['id']}", "source": "youtube",
                       "channel": info.get("channel") or info.get("uploader") or "",
                       "url": f"https://www.youtube.com/watch?v={e['id']}",
                       "title": e.get("title") or "", "text": e.get("title") or "",
                       "duration": e.get("duration")}


def list_tiktok(account: str, limit: int):
    url = account if account.startswith("http") else f"https://www.tiktok.com/@{account.lstrip('@')}"
    with yt_dlp.YoutubeDL(ydl_opts(extract_flat="in_playlist", playlistend=limit)) as y:
        info = y.extract_info(url, download=False)
    for e in info.get("entries") or []:
        if e.get("id"):
            yield {"id": f"tiktok:{e['id']}", "source": "tiktok",
                   "channel": info.get("uploader") or account,
                   "url": e.get("url") or f"{url}/video/{e['id']}",
                   "title": e.get("title") or e.get("description") or "",
                   "text": f"{e.get('title') or ''} {e.get('description') or ''}"}


def list_instagram(account: str, limit: int):
    """Publications vidéo d'un compte Instagram (nécessite une session, voir README)."""
    if not IG_SESSIONID:
        raise RuntimeError("session Instagram absente : ajoute le secret IG_SESSIONID (voir README)")
    import instaloader
    L = instaloader.Instaloader(download_pictures=False, download_videos=False,
                                download_video_thumbnails=False, save_metadata=False,
                                compress_json=False, quiet=True, max_connection_attempts=2)
    L.context._session.cookies.set("sessionid", IG_SESSIONID, domain=".instagram.com")
    if IG_USERNAME:
        L.context.username = IG_USERNAME
    user = account.rstrip("/").split("/")[-1].lstrip("@")
    profile = instaloader.Profile.from_username(L.context, user)
    for i, post in enumerate(profile.get_posts()):
        if i >= min(limit, 60):  # Instagram limite vite : on reste raisonnable
            break
        if not post.is_video:
            continue
        caption = post.caption or ""
        yield {"id": f"instagram:{post.shortcode}", "source": "instagram",
               "channel": profile.full_name or user,
               "url": f"https://www.instagram.com/p/{post.shortcode}/",
               "title": caption.split("\n")[0][:140], "text": caption,
               "duration": int(post.video_duration or 0) or None,
               "thumbnail": post.url,
               "published_at": post.date_utc.replace(tzinfo=timezone.utc).isoformat()}


def list_rss(feed: str):
    d = feedparser.parse(feed, request_headers=UA)
    for e in d.entries:
        link = e.get("link")
        if not link:
            continue
        pub = None
        if e.get("published_parsed"):
            pub = datetime(*e.published_parsed[:6], tzinfo=timezone.utc).isoformat()
        yield {"id": f"web:{link}", "source": "bfmtv", "channel": "bfmtv.com",
               "url": link, "title": e.get("title", ""),
               "text": f"{e.get('title', '')} {e.get('summary', '')}", "published_at": pub}


VIDEO_LINK = re.compile(r"_VN-?\d{8,}", re.I)  # pages vidéo BFM : ..._VN-202609250733.html


def list_page(page: str):
    """Rubrique d'un site (ex. bfmtv.com/marseille/) : récupère les liens de vidéos."""
    r = requests.get(page, headers=UA, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    seen = set()
    for a in soup.find_all("a", href=True):
        href = urljoin(page, a["href"]).split("#")[0]
        if href in seen or not VIDEO_LINK.search(href) or not href.startswith("http"):
            continue
        seen.add(href)
        title = a.get_text(" ", strip=True)
        yield {"id": f"web:{href}", "source": "bfmtv", "channel": "bfmtv.com",
               "url": href, "title": title, "text": title}


SEEN: list[str] = []
SEEN_SET: set[str] = set()
SEEN_DIRTY = [0]


def load_seen():
    global SEEN, SEEN_SET
    SEEN, _ = db.read("data/seen.json", [])
    SEEN_SET = set(SEEN)


def mark_seen(vid: str, flush_every: int = 25):
    if vid in SEEN_SET:
        return
    SEEN.append(vid)
    SEEN_SET.add(vid)
    SEEN_DIRTY[0] += 1
    if SEEN_DIRTY[0] >= flush_every:
        flush_seen()


ANALYSES: list[dict] = []   # journal des analyses de ce passage, pas encore écrit
PROGRESS = {}               # progression du passage en cours (lue par l'app)
LAST_FLUSH = [0.0]


def log_analysis(v: dict, res: dict):
    ANALYSES.append({
        "id": v["id"], "at": datetime.now(timezone.utc).isoformat(), "run": PROGRESS.get("id"),
        "source": v.get("source"), "channel": v.get("channel"), "title": v.get("title") or "",
        "url": v.get("url"), "thumbnail": v.get("thumbnail"), "duration": v.get("duration"),
        **res,
    })


def flush_progress(force: bool = False):
    """Écrit la progression et le journal toutes les ~90 s (l'app les affiche en direct)."""
    if not force and time.time() - LAST_FLUSH[0] < 90:
        return
    LAST_FLUSH[0] = time.time()
    flush_seen()
    if ANALYSES:
        batch = ANALYSES[:]
        db.update("data/analyses.json", [], lambda old: (old + batch)[-800:], "veille : journal d'analyse")
        del ANALYSES[:len(batch)]
    if PROGRESS:
        snap = dict(PROGRESS, updated_at=datetime.now(timezone.utc).isoformat())

        def upd(lst):
            for x in lst:
                if x["id"] == snap["id"]:
                    x.update(snap)
            return lst
        db.update("data/runs.json", [], upd, "veille : progression")


def flush_seen():
    if not SEEN_DIRTY[0]:
        return
    keep = SEEN[-30000:]
    db.update("data/seen.json", [], lambda old: list(dict.fromkeys(old + keep))[-30000:],
              "veille : vidéos analysées")
    SEEN_DIRTY[0] = 0


# ============================================================ références (visage / voix)

class FaceMatcher:
    def __init__(self):
        from insightface.app import FaceAnalysis
        self.app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"],
                                allowed_modules=["detection", "recognition"])
        self.app.prepare(ctx_id=-1, det_size=(640, 640))
        self.refs = []

    def add_reference(self, path: str):
        import cv2
        img = cv2.imread(path)
        if img is None:
            return
        faces = self.app.get(img)
        if faces:  # le plus grand visage de la photo
            f = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
            self.refs.append(f.normed_embedding)

    def score(self, video: str, tmp: str, every: float):
        """% de ressemblance + nombre d'images où ton visage apparaît."""
        import cv2
        if not self.refs:
            return None, 0
        fdir = os.path.join(tmp, "frames")
        shutil.rmtree(fdir, ignore_errors=True)
        os.makedirs(fdir)
        ffmpeg("-i", video, "-vf", f"fps=1/{every},scale='min(960,iw)':-2", "-q:v", "3",
               os.path.join(fdir, "%05d.jpg"))
        refs = np.stack(self.refs)
        sims = []
        for p in sorted(glob.glob(os.path.join(fdir, "*.jpg"))):
            img = cv2.imread(p)
            for f in self.app.get(img):
                if (f.bbox[2] - f.bbox[0]) < 40:  # visages trop petits : peu fiables
                    continue
                sims.append(float(np.max(refs @ f.normed_embedding)))
        shutil.rmtree(fdir, ignore_errors=True)
        if not sims:
            return 0, 0
        sims.sort(reverse=True)
        top = float(np.mean(sims[:2]))  # 2 meilleures images : évite un faux positif isolé
        hits = sum(1 for s in sims if s >= 0.45)
        return to_pct(top, 0.25, 0.55), hits


class VoiceMatcher:
    WIN, HOP = 3.0, 1.5  # fenêtres de 3 s

    def __init__(self):
        from speechbrain.inference.speaker import EncoderClassifier
        self.model = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir=os.path.expanduser("~/.cache/speechbrain/ecapa"),
            run_opts={"device": "cpu"})
        self.ref = None
        self._acc = []

    def _windows(self, wav: str):
        import soundfile as sf
        audio, sr = sf.read(wav, dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        w, h = int(self.WIN * sr), int(self.HOP * sr)
        chunks = [audio[i:i + w] for i in range(0, max(1, len(audio) - w + 1), h)]
        # on ignore les silences
        return [c for c in chunks if len(c) == w and np.sqrt(np.mean(c ** 2)) > 0.01]

    def _embed(self, chunks):
        import torch
        out = []
        for i in range(0, len(chunks), 32):
            batch = torch.from_numpy(np.stack(chunks[i:i + 32]))
            e = self.model.encode_batch(batch).squeeze(1).numpy()
            out.append(e / np.linalg.norm(e, axis=1, keepdims=True))
        return np.concatenate(out) if out else np.zeros((0, 192))

    def add_reference(self, wav: str):
        ch = self._windows(wav)
        if ch:
            self._acc.append(self._embed(ch))

    def finalize(self):
        if self._acc:
            m = np.concatenate(self._acc).mean(axis=0)
            self.ref = m / np.linalg.norm(m)

    def score(self, wav: str):
        if self.ref is None:
            return None
        ch = self._windows(wav)
        if not ch:
            return 0
        sims = self._embed(ch) @ self.ref
        top = float(np.mean(np.sort(sims)[-3:]))  # moyenne des 3 meilleures fenêtres
        return to_pct(top, 0.25, 0.60)


def load_references(s: dict, tmp: str):
    face = voice = None
    files = {"face": [], "voice": []}
    for kind in files:
        try:
            for obj in db.list_dir(f"refs/{kind}"):
                name = obj.get("name")
                if not name or name.startswith("."):
                    continue
                data = db.read_bytes(obj["path"])
                p = os.path.join(tmp, f"ref-{kind}-{safe(name)}")
                with open(p, "wb") as f:
                    f.write(data)
                files[kind].append(p)
        except Exception as e:
            log("Références", kind, "illisibles :", str(e)[:150])

    if s["face_enabled"] and files["face"]:
        face = FaceMatcher()
        for p in files["face"]:
            face.add_reference(p)
        log(f"Visage : {len(face.refs)} photo(s) de référence exploitables")
        if not face.refs:
            face = None

    if s["voice_enabled"] and files["voice"]:
        voice = VoiceMatcher()
        for p in files["voice"]:
            wav = p + ".wav"
            try:
                ffmpeg("-i", p, "-ac", "1", "-ar", "16000", wav)
                voice.add_reference(wav)
            except Exception as e:
                log("Extrait de voix illisible :", str(e)[:120])
        voice.finalize()
        if voice.ref is None:
            voice = None
        else:
            log("Voix : empreinte de référence prête")
    return face, voice


# ============================================================ analyses

_whisper = None


def transcribe(wav: str) -> str:
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        _whisper = WhisperModel("small", device="cpu", compute_type="int8")
    segs, _ = _whisper.transcribe(wav, language="fr", vad_filter=True)
    return " ".join(x.text for x in segs)


def full_info(url: str):
    with yt_dlp.YoutubeDL(ydl_opts()) as y:
        return y.extract_info(url, download=False)


def subtitles_text(info) -> str:
    caps = (info.get("subtitles") or {}) | (info.get("automatic_captions") or {})
    tracks = caps.get("fr") or caps.get("fr-FR") or caps.get("fr-orig") or []
    vtt = next((t for t in tracks if t.get("ext") == "vtt"), None)
    if not vtt:
        return ""
    r = requests.get(vtt["url"], headers=UA, timeout=30)
    if r.status_code != 200:
        return ""
    lines = [l for l in r.text.splitlines()
             if l and "-->" not in l and not l.startswith(("WEBVTT", "Kind:", "Language:"))]
    return re.sub(r"<[^>]+>", "", " ".join(lines))


def article_text(url: str) -> str:
    try:
        r = requests.get(url, headers=UA, timeout=30)
        if r.status_code != 200:
            return ""
        soup = BeautifulSoup(r.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
            tag.decompose()
        main = soup.find("article") or soup.find("main") or soup.body
        return main.get_text(" ", strip=True) if main else ""
    except Exception:
        return ""


def download(url: str, out_base: str, max_height: int) -> str:
    """Meilleure qualité jusqu'à max_height, en privilégiant le H.264 (lisible partout)."""
    opts = ydl_opts(format="bv*+ba/b", merge_output_format="mp4",
                    format_sort=[f"res:{max_height}", "vcodec:h264", "acodec:m4a"],
                    outtmpl=out_base + ".%(ext)s")
    with yt_dlp.YoutubeDL(opts) as y:
        y.download([url])
    files = [f for f in glob.glob(out_base + ".*") if not f.endswith((".part", ".ytdl"))]
    if not files:
        raise RuntimeError("téléchargement sans fichier en sortie")
    return files[0]


def analyse(v: dict, s: dict, names: list[str], face, voice, tmp: str) -> dict:
    """Calcule les scores d'une vidéo. Renvoie un dict de résultats."""
    res = {"name": 0, "face": None, "voice": None, "face_hits": 0,
           "match_type": None, "excerpt": "", "too_long": False}

    def name_hit(m, kind):
        if m and m[0] > res["name"]:
            res.update(name=m[0], match_type=kind, excerpt=m[1][:400])

    name_hit(find_name(v["text"], names), "text")

    info = full_info(v["url"])
    v["title"] = v.get("title") or info.get("title") or ""
    v["duration"] = v.get("duration") or info.get("duration")
    v["thumbnail"] = v.get("thumbnail") or info.get("thumbnail")
    v["channel"] = info.get("channel") or info.get("uploader") or v.get("channel") or ""
    if info.get("timestamp") and not v.get("published_at"):
        v["published_at"] = datetime.fromtimestamp(info["timestamp"], timezone.utc).isoformat()
    elif info.get("upload_date") and not v.get("published_at"):
        d = info["upload_date"]
        v["published_at"] = f"{d[:4]}-{d[4:6]}-{d[6:]}T12:00:00+00:00"

    if res["name"] < 100:
        extra = (info.get("description") or "") + " " + \
                (article_text(v["url"]) if v["source"] == "bfmtv" else "")
        name_hit(find_name(extra, names), "text")
    if res["name"] < 100 and v["source"] == "youtube":
        name_hit(find_name(subtitles_text(info), names, fuzzy=True), "subtitles")

    dur = v.get("duration") or 0
    if dur and dur > s["max_duration_min"] * 60:
        res["too_long"] = True
        return res

    need_media = face or voice or (s["whisper_enabled"] and res["name"] < 100)
    if not need_media:
        return res

    # copie légère (480p) pour l'analyse
    vid = download(v["url"], os.path.join(tmp, "analyse"), 480)
    wav = os.path.join(tmp, "analyse.wav")
    try:
        has_audio = True
        try:
            ffmpeg("-i", vid, "-vn", "-ac", "1", "-ar", "16000", wav)
        except subprocess.CalledProcessError:
            has_audio = False

        if face:
            res["face"], res["face_hits"] = face.score(vid, tmp, s["frame_interval"])
        if voice and has_audio:
            res["voice"] = voice.score(wav)
        if s["whisper_enabled"] and res["name"] < 100 and has_audio:
            tail = os.path.join(tmp, "fin.wav")
            ffmpeg("-sseof", f"-{s['tail_seconds']}", "-i", wav, tail)
            name_hit(find_name(transcribe(tail), names, fuzzy=True), "speech")
            os.remove(tail)
    finally:
        for f in glob.glob(os.path.join(tmp, "analyse*")):
            os.remove(f)
    return res


def global_score(r: dict) -> int:
    parts = [r["name"], r["face"] or 0, r["voice"] or 0]
    g = max(parts)
    # visage et voix moyens mais concordants : on renforce
    if (r["face"] or 0) >= 50 and (r["voice"] or 0) >= 50:
        g = max(g, min(100, (r["face"] + r["voice"]) // 2 + 15))
    return int(g)


# ============================================================ stockage

def find_duplicate(v: dict):
    """Même reportage déjà enregistré depuis une autre plateforme ?"""
    if not v.get("published_at") or not v.get("title"):
        return None
    d = datetime.fromisoformat(v["published_at"])
    videos, _ = db.read("data/videos.json", [])
    for x in videos:
        if not x.get("published_at"):
            continue
        if abs(datetime.fromisoformat(x["published_at"]) - d) > timedelta(days=2):
            continue
        if fuzz.token_set_ratio(norm(x.get("title") or ""), norm(v["title"])) >= 90:
            return x
    return None


def probe(f: str):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "stream=height", "-of", "csv=p=0", f],
                         capture_output=True, text=True).stdout.strip()
    return int(out.split(",")[0]) if out and out.split(",")[0].isdigit() else None


_releases = {}


def release_for(year: str) -> dict:
    """Une release par année dans le repo privé de stockage."""
    if year in _releases:
        return _releases[year]
    tag = f"annee-{year}"
    r = requests.get(f"https://api.github.com/repos/{STORAGE_REPO}/releases/tags/{tag}", headers=GH, timeout=30)
    if r.status_code == 404:
        r = requests.post(f"https://api.github.com/repos/{STORAGE_REPO}/releases", headers=GH, timeout=30,
                          json={"tag_name": tag, "name": f"Tournages {year}", "body": "Archive automatique."})
    r.raise_for_status()
    _releases[year] = r.json()
    return _releases[year]


def upload(f: str, year: str):
    """Envoie le fichier dans la release de l'année. Renvoie (id, nom)."""
    rel = release_for(year)
    base = re.sub(r"[^\w.-]+", "_", unicodedata.normalize("NFKD", os.path.basename(f))
                  .encode("ascii", "ignore").decode())[:180]
    name = base
    for attempt in range(5):
        with open(f, "rb") as fh:
            r = requests.post(
                f"https://uploads.github.com/repos/{STORAGE_REPO}/releases/{rel['id']}/assets",
                params={"name": name}, data=fh, timeout=1800,
                headers={**GH, "Content-Type": "video/mp4",
                         "Content-Length": str(os.path.getsize(f))})
        if r.status_code == 422:  # nom déjà pris dans cette release
            stem, ext = os.path.splitext(base)
            name = f"{stem}_{attempt + 2}{ext}"
            continue
        r.raise_for_status()
        a = r.json()
        return str(a["id"]), a["name"]
    raise RuntimeError("envoi impossible : nom de fichier en conflit")


def delete_asset(asset_id: str):
    r = requests.delete(f"https://api.github.com/repos/{STORAGE_REPO}/releases/assets/{asset_id}",
                        headers=GH, timeout=30)
    if r.status_code not in (204, 404):
        r.raise_for_status()


def store_file(v: dict, s: dict, tmp: str) -> dict:
    date = (v.get("published_at") or START.isoformat())[:10]
    chan = safe(v.get("channel") or v["source"])
    name = safe(f"{date} - {chan} - {v.get('title') or 'reportage'}")
    year = date[:4]
    out = {}

    f = download(v["url"], os.path.join(tmp, name), s["max_quality"])
    out["file_height"] = probe(f)
    out["file_size"] = os.path.getsize(f)
    out["file_id"], out["file_name"] = upload(f, year)
    os.remove(f)

    # Si l'original dépasse le 1080p (4K…), on garde aussi une version 1080p
    if (out["file_height"] or 0) > 1080:
        f2 = download(v["url"], os.path.join(tmp, name + " 1080p"), 1080)
        out["file_1080_id"], _ = upload(f2, year)
        os.remove(f2)
    return out


def purge_rejected():
    """Supprime du stockage les vidéos écartées dans l'app."""
    videos, _ = db.read("data/videos.json", [])
    done = set()
    for v in videos:
        if v.get("status") != "rejected" or not v.get("file_id"):
            continue
        try:
            for a in (v["file_id"], v.get("file_1080_id")):
                if a:
                    delete_asset(a)
            done.add(v["id"])
        except Exception as e:
            log("Suppression impossible :", str(e)[:120])
    if done:
        def clear(lst):
            for x in lst:
                if x["id"] in done:
                    x.update(file_id=None, file_1080_id=None, file_name=None)
            return lst
        db.update("data/videos.json", [], clear, "veille : fichiers écartés supprimés")


def process(v: dict, s, names, face, voice, tmp, manual=False) -> bool:
    r = analyse(v, s, names, face, voice, tmp)
    g = global_score(r)
    res = {"score": g, "score_name": r["name"], "score_face": r["face"], "score_voice": r["voice"],
           "face_hits": r["face_hits"], "match_type": r["match_type"]}
    if r["too_long"] and not manual:
        log_analysis(v, {**res, "decision": "too_long"})
        return False
    if g < s["threshold"] and not manual:
        log_analysis(v, {**res, "decision": "below"})
        return False

    dup = find_duplicate(v)
    if dup and dup["id"] != v["id"]:
        urls = sorted(set((dup.get("other_urls") or []) + [v["url"]]) - {dup["url"]})
        def add_urls(lst):
            for x in lst:
                if x["id"] == dup["id"]:
                    x["other_urls"] = urls
            return lst
        db.update("data/videos.json", [], add_urls, "veille : autre lien ajouté")
        log("Doublon d'une vidéo déjà enregistrée, lien ajouté")
        log_analysis(v, {**res, "decision": "duplicate"})
        return False

    files = {} if r["too_long"] else store_file(v, s, tmp)
    row = {
        **files,
        "id": v["id"], "source": v["source"], "channel": v.get("channel"),
        "url": v["url"], "title": v.get("title"),
        "published_at": v.get("published_at"), "duration": v.get("duration"),
        "thumbnail": v.get("thumbnail"),
        "match_type": "manual" if manual and g < s["threshold"] else r["match_type"],
        "match_excerpt": r["excerpt"],
        "score": g, "score_name": r["name"], "score_face": r["face"],
        "score_voice": r["voice"], "face_hits": r["face_hits"],
        "status": "kept" if manual else "pending",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    db.update("data/videos.json", [], lambda lst: [x for x in lst if x["id"] != row["id"]] + [row],
              f"veille : nouveau tournage ({row['published_at'] or ''})"[:70])
    log("Vidéo enregistrée")
    log_analysis(v, {**res, "decision": "saved"})
    notify("Nouveau tournage trouvé", f"{v.get('title') or 'Vidéo'} ({g} %)", "/?tab=pending")
    return True


# ============================================================ boucle principale

def main():
    stored, _ = db.read("data/settings.json", {})
    s = {**DEFAULT_SETTINGS, **stored}
    names = [n for n in s["name_variants"] if n.strip()]
    run = {"id": START.strftime("%Y%m%d%H%M%S"), "started_at": START.isoformat(), "status": "running",
           "checked": 0, "found": 0}
    db.update("data/runs.json", [], lambda l: ([run] + [x for x in l if x["id"] != run["id"]])[:60],
              "veille : début de passage")
    load_seen()
    PROGRESS.update(id=run["id"], phase="Préparation")
    errors, checked, found = [], 0, 0
    tmp = tempfile.mkdtemp()
    # état de chaque plateforme, affiché dans l'app
    plat = {"youtube": ("off", "Aucune chaîne dans les réglages"),
            "bfmtv": ("off", "Aucune rubrique dans les réglages"),
            "tiktok": ("off", "Aucun compte dans les réglages"),
            "instagram": ("off", "Session Instagram non configurée" if not IG_SESSIONID
                          else "Aucun compte dans les réglages")}

    def write_platforms():
        now = datetime.now(timezone.utc).isoformat()
        db.update("data/platforms.json", {}, lambda _: {k: {"status": st, "detail": d, "updated_at": now}
                                                         for k, (st, d) in plat.items()},
                  "veille : état des plateformes")

    def finish(status=None):
        shutil.rmtree(tmp, ignore_errors=True)
        PROGRESS.update(phase="Terminé", current=None)
        flush_progress(force=True)
        now = datetime.now(timezone.utc).isoformat()
        write_platforms()
        done = {"finished_at": now, "checked": checked, "found": found,
                "status": status or ("ok" if not errors else "error"),
                "errors": "\n".join(errors[:40]) or None}

        def end(lst):
            for x in lst:
                if x["id"] == run["id"]:
                    x.update(done)
            return lst
        db.update("data/runs.json", [], end, "veille : fin de passage")

    if not names:
        errors.append("Aucun nom configuré dans les réglages.")
        return finish("error")

    build_cookiefile(tmp)
    purge_rejected()
    face, voice = load_references(s, tmp)
    if s["face_enabled"] and not face:
        errors.append("Reconnaissance du visage activée mais aucune photo exploitable.")
    if s["voice_enabled"] and not voice:
        errors.append("Reconnaissance de la voix activée mais aucun extrait exploitable.")

    # 1) liens ajoutés à la main dans l'app
    queue, _ = db.read("data/queue.json", [])
    results = {}
    for q in [x for x in queue if not x.get("processed")]:
        u = q["url"].lower()
        src = next((k for k in ("instagram", "tiktok", "youtube", "facebook") if k in u),
                   "x" if ("x.com" in u or "twitter.com" in u) else "bfmtv" if "bfmtv" in u else "manual")
        v = {"id": f"manual:{q['url']}", "source": src, "url": q["url"], "title": "", "text": ""}
        try:
            if process(v, s, names, face, voice, tmp, manual=True):
                found += 1
            results[q["id"]] = None
        except Exception as e:
            msg = str(e).splitlines()[0][:250]
            results[q["id"]] = msg
            errors.append(f"Lien ajouté {q['url']} : {msg}")
    if results:
        def mark(lst):
            for x in lst:
                if x["id"] in results:
                    x.update(processed=True, error=results[x["id"]])
            return lst[-200:]
        db.update("data/queue.json", [], mark, "veille : liens ajoutés traités")

    # 2) sources surveillées, dans l'ordre des réglages
    candidates = []
    sources = [("youtube", list_youtube, ch, (s["lookback"],)) for ch in s["youtube_channels"]] + \
              [("tiktok", list_tiktok, a, (s["lookback"],)) for a in s["tiktok_accounts"]] + \
              [("instagram", list_instagram, a, (s["lookback"],)) for a in s["instagram_accounts"]] + \
              [("bfmtv", list_page, p, ()) for p in s["pages"]] + \
              [("bfmtv", list_rss, f, ()) for f in s["rss_feeds"]]
    counts = {}
    for kind, fn, src, args in sources:
        PROGRESS.update(phase="Lecture des sources", current=src)
        flush_progress()
        try:
            got = list(fn(src, *args))
            log(f"{src} : {len(got)} vidéos listées")
            candidates += got
            counts[kind] = counts.get(kind, 0) + len(got)
            if plat[kind][0] != "error":
                plat[kind] = ("ok", f"{counts[kind]} vidéos récentes lues")
        except Exception as e:
            msg = str(e).splitlines()[0][:200]
            errors.append(f"Source {src} : {msg}")
            blocked_kw = ("Sign in", "429", "login", "rate", "wait a few minutes", "checkpoint", "401", "403")
            plat[kind] = ("error", ("Bloqué par la plateforme : " if any(k in msg for k in blocked_kw)
                                    else "Erreur : ") + msg[:140])

    uniq = list({c["id"]: c for c in candidates}.values())
    todo = [c for c in uniq if c["id"] not in SEEN_SET]
    log(f"{len(todo)} nouvelles vidéos à analyser")
    PROGRESS.update(phase="Analyse", total=len(todo), listed=len(uniq), done=0)
    write_platforms()
    flush_progress(force=True)

    blocked = set()
    for v in todo:
        if v["source"] in blocked:
            continue
        if not time_left():
            errors.append(f"Temps maximum atteint : {len(todo) - checked} vidéos reportées au prochain passage.")
            break
        PROGRESS.update(current=(v.get("title") or v["url"])[:140], current_source=v["source"],
                        done=checked, found=found)
        flush_progress()
        try:
            if process(v, s, names, face, voice, tmp):
                found += 1
            mark_seen(v["id"])
            checked += 1
        except Exception as e:
            msg = str(e).splitlines()[0][:250]
            if any(k in msg for k in ("Sign in to confirm", "429", "login required", "rate-limit", "Please wait a few minutes", "checkpoint",
                                 "needs to be reloaded", "cookies are no longer valid", "not a bot")):
                blocked.add(v["source"])
                if v["source"] in plat:
                    hint = (" : cookies refusés, à exporter de nouveau (voir le mode d'emploi)"
                            if v["source"] == "youtube" else "")
                    plat[v["source"]] = ("error", "Bloqué par la plateforme pendant l'analyse" + hint)
                    write_platforms()
                errors.append(f"{v['source']} bloque les requêtes : voir « Si une plateforme bloque » dans le README.")
            else:
                errors.append(f"{v['url']} : {msg}")
                log_analysis(v, {"decision": "error", "error": msg})
                mark_seen(v["id"])  # on ne réessaie pas indéfiniment
                checked += 1

    finish()
    log(f"Terminé : {checked} analysées, {found} enregistrées, {len(errors)} remarques")
    if errors and not found:
        notify("Veille terminée avec des remarques", f"{len(errors)} remarque(s) : voir l'onglet Historique.", "/?tab=history")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        notify("La veille a rencontré une erreur", "Voir l'onglet Actions sur GitHub.", "/?tab=history")
        sys.exit(1)
