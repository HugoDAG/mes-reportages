import { guard, updateJson } from './_lib.js'

const STATUSES = ['pending', 'kept', 'rejected']
const SETTING_KEYS = ['name_variants', 'youtube_channels', 'tiktok_accounts', 'instagram_accounts', 'pages',
  'rss_feeds', 'lookback', 'max_duration_min', 'tail_seconds', 'frame_interval', 'threshold',
  'whisper_enabled', 'face_enabled', 'voice_enabled', 'max_quality']

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  if (!guard(req, res)) return
  const b = req.body || {}
  try {
    if (b.type === 'status') {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Statut inconnu.' })
      await updateJson('data/videos.json', [], (list) => {
        const v = list.find((x) => x.id === b.id)
        if (!v) return undefined
        v.status = b.status
        return list
      }, `app : ${b.status === 'kept' ? 'tournage validé' : b.status === 'rejected' ? 'tournage écarté' : 'tournage à revoir'}`)
      return res.json({ ok: true })
    }
    if (b.type === 'settings') {
      const clean = {}
      for (const k of SETTING_KEYS) if (k in (b.settings || {})) clean[k] = b.settings[k]
      const next = await updateJson('data/settings.json', {}, (s) => ({ ...s, ...clean, updated_at: new Date().toISOString() }),
        'app : réglages modifiés')
      return res.json({ ok: true, settings: next })
    }
    if (b.type === 'queue') {
      const u = String(b.url || '').trim()
      if (!/^https?:\/\/\S+$/.test(u)) return res.status(400).json({ error: 'Lien invalide.' })
      await updateJson('data/queue.json', [], (q) => [...q, { id: Date.now().toString(36), url: u, added_at: new Date().toISOString(), processed: false }],
        'app : lien ajouté')
      return res.json({ ok: true })
    }
    if (b.type === 'push') {
      const sub = b.subscription
      if (!sub?.endpoint) return res.status(400).json({ error: 'Abonnement invalide.' })
      await updateJson('data/push.json', [], (l) => [...l.filter((x) => x.endpoint !== sub.endpoint),
        { endpoint: sub.endpoint, subscription: sub, user_agent: String(b.user_agent || '').slice(0, 200), created_at: new Date().toISOString() }],
      'app : notifications activées')
      return res.json({ ok: true })
    }
    res.status(400).json({ error: 'Action inconnue.' })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
}
