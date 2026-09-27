"""
Installation automatique de « Mes reportages » (workflow « Installation »).
Crée le projet Vercel, y range les variables, déploie l'app puis lance une première veille.
Les données et les vidéos sont dans le repo privé de stockage : aucun autre service.
"""
import os
import sys
import subprocess

import requests

VC_TOKEN = os.environ["VERCEL_TOKEN"]
REPO = os.environ["GITHUB_REPOSITORY"]
PROJECT = "mes-reportages"
VC = "https://api.vercel.com"
VCH = {"Authorization": f"Bearer {VC_TOKEN}", "Content-Type": "application/json"}


def fail(msg):
    print(f"::error title=Installation interrompue::{msg}", flush=True)
    sys.exit(1)


def ok(r, what):
    if r.status_code >= 300:
        fail(f"{what} : HTTP {r.status_code} {r.text[:400]}")
    return r.json() if r.text else {}


print("=== Vercel : compte")
user = ok(requests.get(f"{VC}/v2/user", headers=VCH), "Compte Vercel")["user"]
team = user.get("defaultTeamId")
q = {"teamId": team} if team else {}

print("=== Vercel : projet")
r = requests.get(f"{VC}/v9/projects/{PROJECT}", headers=VCH, params=q)
if r.status_code == 200:
    vp = r.json()
    print("Projet existant réutilisé")
else:
    body = {"name": PROJECT, "framework": "vite", "rootDirectory": "web",
            "gitRepository": {"type": "github", "repo": REPO}}
    r = requests.post(f"{VC}/v10/projects", headers=VCH, params=q, json=body)
    if r.status_code >= 300:
        print("Liaison GitHub impossible, projet créé sans liaison :", r.text[:200])
        body.pop("gitRepository")
        r = requests.post(f"{VC}/v10/projects", headers=VCH, params=q, json=body)
    vp = ok(r, "Création du projet Vercel")
pid = vp["id"]

print("=== Vercel : variables")
env = {k: os.environ[k] for k in ("STORAGE_REPO", "STORAGE_TOKEN", "APP_CODE", "APP_SECRET")}
env["VITE_VAPID_PUBLIC_KEY"] = os.environ["VAPID_PUBLIC_KEY"]
ok(requests.post(f"{VC}/v10/projects/{pid}/env", headers=VCH, params={**q, "upsert": "true"},
                 json=[{"key": k, "value": v, "type": "encrypted",
                        "target": ["production", "preview", "development"]} for k, v in env.items()]),
   "Variables Vercel")

print("=== Vercel : déploiement")
denv = {**os.environ, "VERCEL_ORG_ID": team or user["id"], "VERCEL_PROJECT_ID": pid}
out = subprocess.run(["npx", "--yes", "vercel@latest", "deploy", "--prod", "--yes", f"--token={VC_TOKEN}"],
                     env=denv, capture_output=True, text=True)
print(out.stdout[-1500:], out.stderr[-1500:])
if out.returncode != 0:
    fail("Déploiement Vercel échoué (voir le journal).")

doms = requests.get(f"{VC}/v9/projects/{pid}/domains", headers=VCH, params=q).json().get("domains", [])
domain = next((d["name"] for d in doms if d["name"].endswith(".vercel.app")), None) or f"{PROJECT}.vercel.app"
app_url = f"https://{domain}"

print("=== Première veille")
subprocess.run(["gh", "workflow", "run", "veille.yml", "--repo", REPO], check=False)

print(f"::notice title=App prête::{app_url}", flush=True)
with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
    f.write(f"## ✅ Mes reportages est installée\n\n**App : {app_url}**\n\nUne première veille vient d'être lancée.\n")
