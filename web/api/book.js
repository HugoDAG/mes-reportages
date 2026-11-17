// Book public (sans connexion) : la sélection « à la une », servie seulement si le book est publié.
import { readJson } from './_lib.js'

export default async function handler(req, res) {
  try {
    const [s, v] = await Promise.all([
      readJson('data/settings.json', {}),
      readJson('data/videos.json', []),
    ])
    const st = s.data || {}
    if (!st.book_public) { res.status(404).json({ error: 'Ce book n’est pas public.' }); return }
    const videos = (v.data || [])
      .filter((x) => x.featured && x.status !== 'rejected' && x.file_id)
      .sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))
      .map((x) => ({
        id: x.id, file: String(x.file_id), title: x.title, channel: x.channel, source: x.source,
        published_at: x.published_at, duration: x.duration, thumbnail: x.thumbnail,
        role: x.role || null, theme: x.theme || null, height: x.file_height || null, url: x.url,
      }))
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      title: st.book_title || 'Mes reportages',
      name: st.book_name || '',
      intro: st.book_intro || '',
      videos,
    })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
}
