"""
Installation automatique de « Mes reportages » (lancée par le workflow « Installation »).

1. Supabase : crée le projet, les tables, le stockage privé, ton compte de connexion
2. Génère les clés de notification (VAPID)
3. Range les clés utiles dans les secrets GitHub
4. Vercel : crée le projet, ajoute les variables, déploie l'app
5. Ferme les inscriptions Supabase et déclare l'adresse de l'app
6. Lance une première veille
"""
import os
import sys
import json
import time
import base64
import secrets
import subprocess

import requests
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives import serialization

SB_TOKEN = os.environ["SUPABASE_ACCESS_TOKEN"]
VC_TOKEN = os.environ["VERCEL_TOKEN"]
EMAIL = os.environ["APP_EMAIL"]
NAMES = json.loads(os.environ.get("APP_NAMES") or "[]")
REPO = os.environ["GITHUB_REPOSITORY"]
STORAGE_REPO = os.environ["STORAGE_REPO"]
STORAGE_TOKEN = os.environ["STORAGE_TOKEN"]
PROJECT = "mes-reportages"

SB = "https://api.supabase.com/v1"
SBH = {"Authorization": f"Bearer {SB_TOKEN}", "Content-Type": "application/json"}
VC = "https://api.vercel.com"
VCH = {"Authorization": f"Bearer {VC_TOKEN}", "Content-Type": "application/json"}


def step(msg):
    print(f"\n=== {msg}", flush=True)


def fail(msg):
    print(f"::error title=Installation interrompue::{msg}", flush=True)
    sys.exit(1)


def notice(title, msg):
    print(f"::notice title={title}::{msg}", flush=True)


def ok(r, what):
    if r.status_code >= 300:
        fail(f"{what} : HTTP {r.status_code} {r.text[:400]}")
    return r.json() if r.text else {}


# ------------------------------------------------------------------ Supabase
step("Supabase : organisation et projet")
orgs = ok(requests.get(f"{SB}/organizations", headers=SBH), "Liste des organisations")
org = next((o for o in orgs if "hugodag" in o["name"].lower()), orgs[0] if orgs else None)
if not org:
    fail("Aucune organisation Supabase trouvée.")
print("Organisation :", org["name"])

projects = ok(requests.get(f"{SB}/projects", headers=SBH), "Liste des projets")
proj = next((p for p in projects if p["name"] == PROJECT), None)
if proj:
    print("Projet existant réutilisé :", proj["id"])
else:
    r = requests.post(f"{SB}/projects", headers=SBH, json={
        "name": PROJECT, "organization_id": org["id"], "region": "eu-west-3",
        "db_pass": secrets.token_urlsafe(24)})
    if r.status_code >= 300:
        active = [f'{p["name"]} ({p.get("status")})' for p in projects
                  if p.get("status") not in ("INACTIVE", "PAUSED", "REMOVED")]
        fail("Création du projet Supabase refusée (quota gratuit probablement atteint). "
             f"Projets actifs : {', '.join(active) or 'aucun'}. Mets un projet en pause puis relance. "
             f"Détail : {r.text[:250]}")
    proj = r.json()
    print("Projet créé :", proj["id"])
ref = proj["id"]

print("Attente du démarrage du projet…")
for _ in range(90):
    st = requests.get(f"{SB}/projects/{ref}", headers=SBH).json().get("status")
    if st == "ACTIVE_HEALTHY":
        break
    time.sleep(10)
else:
    fail("Le projet Supabase ne démarre pas (plus de 15 min). Relance l'installation.")

keys = ok(requests.get(f"{SB}/projects/{ref}/api-keys", headers=SBH, params={"reveal": "true"}), "Clés API")
anon = next(k["api_key"] for k in keys if k.get("name") == "anon")
service = next(k["api_key"] for k in keys if k.get("name") == "service_role")
sb_url = f"https://{ref}.supabase.co"

step("Supabase : tables et stockage")
with open("supabase/schema.sql", encoding="utf-8") as f:
    schema = f.read()
for attempt in range(6):
    r = requests.post(f"{SB}/projects/{ref}/database/query", headers=SBH, json={"query": schema})
    if r.status_code < 300:
        break
    print("Base pas encore prête, nouvel essai…", r.status_code, r.text[:200])
    time.sleep(15)
else:
    fail(f"Création des tables impossible : {r.text[:300]}")

if NAMES:
    arr = ",".join("'" + n.replace("'", "''") + "'" for n in NAMES)
    ok(requests.post(f"{SB}/projects/{ref}/database/query", headers=SBH,
                     json={"query": f"update settings set name_variants = array[{arr}]::text[] where id = 1;"}),
       "Enregistrement du nom recherché")

step("Supabase : compte de connexion")
r = requests.post(f"{sb_url}/auth/v1/admin/users",
                  headers={"apikey": service, "Authorization": f"Bearer {service}"},
                  json={"email": EMAIL, "email_confirm": True})
if r.status_code >= 300 and "already" not in r.text.lower():
    fail(f"Création du compte impossible : {r.text[:300]}")
print("Compte de connexion prêt")

# ------------------------------------------------------------------ Notifications
step("Clés de notification")
key = ec.generate_private_key(ec.SECP256R1())
b64u = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
vapid_private = b64u(key.private_numbers().private_value.to_bytes(32, "big"))
vapid_public = b64u(key.public_key().public_bytes(serialization.Encoding.X962,
                                                   serialization.PublicFormat.UncompressedPoint))

# ------------------------------------------------------------------ Secrets GitHub
step("Secrets GitHub pour la veille")
for name, value in {"SUPABASE_URL": sb_url, "SUPABASE_SERVICE_KEY": service,
                    "VAPID_PRIVATE_KEY": vapid_private, "VAPID_SUBJECT": f"mailto:{EMAIL}"}.items():
    subprocess.run(["gh", "secret", "set", name, "--repo", REPO, "--body", value], check=True)
    print("Secret enregistré :", name)

# ------------------------------------------------------------------ Vercel
step("Vercel : projet")
user = ok(requests.get(f"{VC}/v2/user", headers=VCH), "Compte Vercel")["user"]
team = user.get("defaultTeamId")
q = {"teamId": team} if team else {}

r = requests.get(f"{VC}/v9/projects/{PROJECT}", headers=VCH, params=q)
if r.status_code == 200:
    vp = r.json()
    print("Projet Vercel existant réutilisé")
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

step("Vercel : variables")
env = {"VITE_SUPABASE_URL": sb_url, "VITE_SUPABASE_ANON_KEY": anon, "VITE_VAPID_PUBLIC_KEY": vapid_public,
       "SUPABASE_URL": sb_url, "SUPABASE_ANON_KEY": anon,
       "STORAGE_REPO": STORAGE_REPO, "STORAGE_TOKEN": STORAGE_TOKEN}
ok(requests.post(f"{VC}/v10/projects/{pid}/env", headers=VCH, params={**q, "upsert": "true"},
                 json=[{"key": k, "value": v, "type": "encrypted",
                        "target": ["production", "preview", "development"]} for k, v in env.items()]),
   "Variables Vercel")

step("Vercel : déploiement")
denv = {**os.environ, "VERCEL_ORG_ID": team or user["id"], "VERCEL_PROJECT_ID": pid}
out = subprocess.run(["npx", "--yes", "vercel@latest", "deploy", "--prod", "--yes", f"--token={VC_TOKEN}"],
                     env=denv, capture_output=True, text=True)
print(out.stdout[-2000:], out.stderr[-2000:])
if out.returncode != 0:
    fail("Déploiement Vercel échoué (voir le journal).")

doms = requests.get(f"{VC}/v9/projects/{pid}/domains", headers=VCH, params=q).json().get("domains", [])
domain = next((d["name"] for d in doms if d["name"].endswith(".vercel.app")), None) or f"{PROJECT}.vercel.app"
app_url = f"https://{domain}"

step("Supabase : adresse de l'app et inscriptions fermées")
ok(requests.patch(f"{SB}/projects/{ref}/config/auth", headers=SBH, json={
    "site_url": app_url, "uri_allow_list": f"{app_url}/**", "disable_signup": True}),
   "Réglages de connexion")

step("Première veille")
subprocess.run(["gh", "workflow", "run", "veille.yml", "--repo", REPO], check=False)

notice("App prête", app_url)
with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
    f.write(f"## ✅ Mes reportages est installée\n\n**App : {app_url}**\n\n"
            "Connexion avec ton adresse e-mail. Une première veille vient d'être lancée.\n")
print("\nApp :", app_url)
