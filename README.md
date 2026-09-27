# Mes reportages

Veille automatique des vidéos BFM Marseille Provence et BFMTV. Pour chaque nouvelle vidéo, le moteur calcule un score de ressemblance à partir de trois signaux : le nom (écrit ou prononcé), le visage et la voix. Si le score dépasse le seuil, la vidéo est téléchargée dans la meilleure qualité publiée, rangée par année dans **Mes tournages**, et une notification est envoyée sur l'app installée.

## Architecture (100 % gratuite)

| Élément | Rôle |
|---|---|
| `engine/` + `.github/workflows/veille.yml` | Moteur Python lancé tous les 2 jours par GitHub Actions (repo public : minutes illimitées) |
| `web/` | App React + Vite, installable sur l'écran d'accueil, déployée sur Vercel |
| `web/api/` | Fonctions serveur : connexion par code d'accès, lecture/écriture des données, vidéos |
| Repo privé `mes-tournages-stockage` | Données de l'app (`data/*.json`), photos et voix de référence (`refs/`), vidéos (une release par année) |
| `setup/install.py` + workflow « Installation » | Installation automatique complète |

Ce repo public ne contient aucune donnée personnelle : le nom recherché, les références, les clés et les vidéos sont dans les secrets GitHub, les variables Vercel ou le repo privé.

## Plateformes

| Plateforme | Compte requis ? |
|---|---|
| YouTube | Oui, un compte Google **secondaire** dédié à l'app (YouTube bloque les serveurs de GitHub). Ses cookies vont dans le secret `YT_COOKIES` |
| bfmtv.com | Non |
| TikTok | Non |
| Instagram | Oui, un compte secondaire, sans besoin de suivre les pages. Secrets `IG_SESSIONID` et `IG_USERNAME` |
| Facebook, X | Pas de surveillance automatique : ajout par lien dans l'app |

L'état de chaque plateforme est affiché dans l'app, en haut des Réglages.

## Maintenance

- **Token de stockage** : `STORAGE_TOKEN` doit être un token GitHub « fine-grained », sans expiration, limité au repo `mes-tournages-stockage` avec « Contents : Read and write ». Il est utilisé à deux endroits : dans les secrets de ce repo et dans les variables d'environnement Vercel.
- **Code d'accès** : variable `APP_CODE` dans Vercel (Settings → Environment Variables), puis « Redeploy ».
- **Lancer une veille à la main** : onglet Actions → Veille reportages → Run workflow.
- **Instagram** : copier le cookie `sessionid` d'un compte secondaire connecté sur instagram.com dans le secret `IG_SESSIONID`, puis ajouter les comptes à surveiller dans les réglages de l'app.

Les vidéos appartiennent à leurs diffuseurs : cet outil sert à l'archivage personnel (book), pas à la republication.
