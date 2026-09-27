import { guard, readJson } from './_lib.js'

export default async function handler(req, res) {
  if (!guard(req, res)) return
  try {
    const [settings, videos, runs, platforms, queue] = await Promise.all([
      readJson('data/settings.json', {}),
      readJson('data/videos.json', []),
      readJson('data/runs.json', []),
      readJson('data/platforms.json', {}),
      readJson('data/queue.json', []),
    ])
    res.setHeader('Cache-Control', 'no-store')
    res.json({
      settings: settings.data,
      videos: videos.data,
      runs: runs.data.slice(0, 30),
      platforms: platforms.data,
      queue: queue.data.filter((q) => !q.processed || q.error).slice(-20),
    })
  } catch (e) {
    res.status(502).json({ error: `Stockage injoignable : ${e.message}` })
  }
}
