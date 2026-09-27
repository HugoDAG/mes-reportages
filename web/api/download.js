// Sert une vidéo du stockage privé : redirection vers une URL signée temporaire de GitHub.
// La vidéo ne transite pas par Vercel. Fonctionne pour le téléchargement et pour le lecteur.
import { guard, assetRedirect } from './_lib.js'

export default async function handler(req, res) {
  if (!guard(req, res)) return
  const id = String(req.query.id || '')
  if (!/^\d+$/.test(id)) return res.status(400).send('Lien de fichier invalide.')
  const { status, location } = await assetRedirect(id)
  if (!location) return res.status(status === 404 ? 404 : 502).send('Fichier introuvable dans le stockage.')
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(302, { Location: location })
  res.end()
}
