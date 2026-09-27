// Lance une veille à la demande (GET : état du dernier passage côté GitHub, POST : lancement).
// Nécessite que le token de stockage ait aussi « Actions : Read and write » sur le repo mes-reportages.
import { guard } from './_lib.js'

const APP_REPO = process.env.APP_REPO || 'HugoDAG/mes-reportages'
const GH = {
  Authorization: `Bearer ${process.env.RUN_TOKEN || process.env.STORAGE_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'mes-reportages',
}

export async function latestRun() {
  const r = await fetch(`https://api.github.com/repos/${APP_REPO}/actions/workflows/veille.yml/runs?per_page=1`, { headers: GH })
  if (!r.ok) return null
  const run = (await r.json()).workflow_runs?.[0]
  return run ? { status: run.status, conclusion: run.conclusion, created_at: run.created_at, url: run.html_url } : null
}

export default async function handler(req, res) {
  if (!guard(req, res)) return
  if (req.method === 'GET') return res.json({ run: await latestRun() })
  if (req.method !== 'POST') return res.status(405).end()

  const current = await latestRun()
  if (current && current.status !== 'completed') {
    return res.status(409).json({ error: 'Une analyse est déjà en cours.' })
  }
  const r = await fetch(`https://api.github.com/repos/${APP_REPO}/actions/workflows/veille.yml/dispatches`, {
    method: 'POST',
    headers: { ...GH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main' }),
  })
  if (r.status === 204) return res.json({ ok: true })
  if (r.status === 403 || r.status === 404) {
    return res.status(403).json({ error: 'Le token de stockage n’a pas encore le droit de lancer une analyse. Voir le mode d’emploi, section « Lancer une analyse ».' })
  }
  res.status(502).json({ error: `GitHub a refusé le lancement (${r.status}).` })
}
