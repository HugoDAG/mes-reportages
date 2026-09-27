"""
Stockage des données de l'app dans le repo GitHub privé (fichiers JSON).

  data/settings.json   réglages
  data/videos.json     vidéos trouvées (scores, statut, fichiers)
  data/seen.json       vidéos déjà analysées
  data/runs.json       historique des passages
  data/queue.json      liens ajoutés à la main
  data/platforms.json  état de chaque plateforme
  data/push.json       abonnements aux notifications
  refs/face/*, refs/voice/*   photos et extraits de voix de référence
"""
import json
import time
import base64

import requests

API = "https://api.github.com"


class Conflict(Exception):
    pass


class Store:
    def __init__(self, repo: str, token: str):
        self.repo = repo
        self.h = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                  "X-GitHub-Api-Version": "2022-11-28"}

    def _url(self, path):
        return f"{API}/repos/{self.repo}/contents/{path}"

    def read_bytes(self, path) -> bytes:
        r = requests.get(self._url(path), headers={**self.h, "Accept": "application/vnd.github.raw"}, timeout=120)
        r.raise_for_status()
        return r.content

    def read(self, path, default):
        """(données, sha). sha vaut None si le fichier n'existe pas encore."""
        r = requests.get(self._url(path), headers=self.h, timeout=60)
        if r.status_code == 404:
            return default, None
        r.raise_for_status()
        meta = r.json()
        raw = base64.b64decode(meta["content"]) if meta.get("content") else self.read_bytes(path)
        return json.loads(raw.decode("utf-8") or "null") or default, meta["sha"]

    def write(self, path, data, sha, message):
        body = {"message": message,
                "content": base64.b64encode(json.dumps(data, ensure_ascii=False, indent=1).encode()).decode()}
        if sha:
            body["sha"] = sha
        r = requests.put(self._url(path), headers=self.h, json=body, timeout=120)
        if r.status_code in (409, 422) and "sha" in r.text:
            raise Conflict(path)
        r.raise_for_status()
        return r.json()["content"]["sha"]

    def update(self, path, default, fn, message="veille : mise à jour"):
        """Lire, modifier, écrire — en réessayant si l'app a écrit entre-temps."""
        for attempt in range(6):
            data, sha = self.read(path, default)
            new = fn(data)
            if new is None:
                return data
            try:
                self.write(path, new, sha, message)
                return new
            except Conflict:
                time.sleep(1 + attempt)
        raise RuntimeError(f"écriture impossible (conflits répétés) : {path}")

    def list_dir(self, path):
        r = requests.get(self._url(path), headers=self.h, timeout=60)
        if r.status_code == 404:
            return []
        r.raise_for_status()
        return [e for e in r.json() if e.get("type") == "file"]
