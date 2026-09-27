// Sert un fichier du stockage privé (releases GitHub) après vérification de la session Supabase.
// Le navigateur est redirigé vers une URL signée temporaire : la vidéo ne transite pas par Vercel.
export default async function handler(req, res) {
  const { id, t } = req.query
  if (!id || !/^\d+$/.test(String(id)) || !t) {
    res.status(400).send('Lien de fichier invalide.')
    return
  }

  const me = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${t}` },
  })
  if (!me.ok) {
    res.status(401).send('Session expirée : rouvre l’app pour te reconnecter.')
    return
  }

  const r = await fetch(`https://api.github.com/repos/${process.env.STORAGE_REPO}/releases/assets/${id}`, {
    headers: {
      Authorization: `Bearer ${process.env.STORAGE_TOKEN}`,
      Accept: 'application/octet-stream',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mes-reportages',
    },
    redirect: 'manual',
  })
  const location = r.headers.get('location')
  if (!location) {
    res.status(r.status === 404 ? 404 : 502).send('Fichier introuvable dans le stockage.')
    return
  }
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(302, { Location: location })
  res.end()
}
