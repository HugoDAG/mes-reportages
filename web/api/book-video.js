// Sert une vidéo du book public, sans connexion — mais uniquement une vidéo « à la une »
// d'un book publié. Les autres fichiers restent privés (passent par /api/download).
import { readJson, assetRedirect } from './_lib.js'

export default async function handler(req, res) {
  const id = String(req.query.id || '')
  if (!/^\d+$/.test(id)) return res.status(400).send('Lien invalide.')
  try {
    const [s, v] = await Promise.all([
      readJson('data/settings.json', {}),
      readJson('data/videos.json', []),
    ])
    if (!(s.data || {}).book_public) return res.status(404).send('Indisponible.')
    const allowed = (v.data || []).some((x) =>
      x.featured && x.status !== 'rejected' &&
      (String(x.file_id) === id || String(x.file_1080_id) === id))
    if (!allowed) return res.status(404).send('Indisponible.')
    const { status, location } = await assetRedirect(id)
    if (!location) return res.status(status === 404 ? 404 : 502).send('Introuvable.')
    res.setHeader('Cache-Control', 'no-store')
    res.writeHead(302, { Location: location })
    res.end()
  } catch (e) {
    res.status(502).send('Erreur.')
  }
}
