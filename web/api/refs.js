// Photos et extraits de voix de référence, rangés dans refs/face et refs/voice du repo privé.
import { guard, listDir, readRaw, putFile, deleteFile } from './_lib.js'


const KINDS = ['face', 'voice']
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'audio/webm', wav: 'audio/wav', ogg: 'audio/ogg', mov: 'video/quicktime' }
const okPath = (p) => /^refs\/(face|voice)\/[\w.-]+$/.test(p || '')

export default async function handler(req, res) {
  if (!guard(req, res)) return
  try {
    if (req.method === 'GET' && req.query.path) {
      if (!okPath(req.query.path)) return res.status(400).end()
      const r = await readRaw(req.query.path)
      if (!r.ok) return res.status(404).end()
      const ext = req.query.path.split('.').pop().toLowerCase()
      res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream')
      res.setHeader('Cache-Control', 'private, max-age=3600')
      return res.send(Buffer.from(await r.arrayBuffer()))
    }
    if (req.method === 'GET') {
      if (!KINDS.includes(req.query.kind)) return res.status(400).end()
      const files = await listDir(`refs/${req.query.kind}`)
      return res.json(files.map((f) => ({ name: f.name, path: f.path, size: f.size })).reverse())
    }
    if (req.method === 'POST') {
      const { kind, name, data } = req.body || {}
      if (!KINDS.includes(kind) || !data) return res.status(400).json({ error: 'Fichier invalide.' })
      const clean = `${Date.now()}-${String(name || 'fichier').normalize('NFD').replace(/[^\w.-]+/g, '_').slice(-60)}`
      await putFile(`refs/${kind}/${clean}`, data, `app : référence ${kind === 'face' ? 'photo' : 'voix'} ajoutée`)
      return res.json({ ok: true })
    }
    if (req.method === 'DELETE') {
      if (!okPath(req.query.path)) return res.status(400).end()
      await deleteFile(req.query.path, 'app : référence supprimée')
      return res.json({ ok: true })
    }
    res.status(405).end()
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
}
