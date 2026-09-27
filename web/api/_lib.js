// Outils partagés par les fonctions serveur (fichiers commençant par « _ » : pas une route).
import crypto from 'node:crypto'

const REPO = process.env.STORAGE_REPO
const GH = {
  Authorization: `Bearer ${process.env.STORAGE_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'mes-reportages',
}
const url = (path) => `https://api.github.com/repos/${REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}`

/* ------------------------------------------------------------ données (repo privé) */

export async function readRaw(path) {
  return fetch(url(path), { headers: { ...GH, Accept: 'application/vnd.github.raw' } })
}

export async function readJson(path, fallback) {
  const r = await fetch(url(path), { headers: GH })
  if (r.status === 404) return { data: fallback, sha: null }
  if (!r.ok) throw new Error(`Lecture ${path} : ${r.status}`)
  const meta = await r.json()
  let text
  if (meta.content) text = Buffer.from(meta.content, 'base64').toString('utf8')
  else text = await (await readRaw(path)).text()
  return { data: JSON.parse(text || 'null') ?? fallback, sha: meta.sha }
}

async function put(path, base64, sha, message) {
  const r = await fetch(url(path), {
    method: 'PUT',
    headers: { ...GH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: base64, ...(sha ? { sha } : {}) }),
  })
  if (r.status === 409 || (r.status === 422 && (await r.clone().text()).includes('sha'))) {
    const e = new Error('conflict'); e.conflict = true; throw e
  }
  if (!r.ok) throw new Error(`Écriture ${path} : ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}

export async function updateJson(path, fallback, fn, message) {
  for (let i = 0; i < 6; i++) {
    const { data, sha } = await readJson(path, fallback)
    const next = await fn(structuredClone(data))
    if (next === undefined) return data
    try {
      await put(path, Buffer.from(JSON.stringify(next, null, 1)).toString('base64'), sha, message)
      return next
    } catch (e) {
      if (!e.conflict) throw e
      await new Promise((ok) => setTimeout(ok, 400 * (i + 1)))
    }
  }
  throw new Error(`Écriture impossible (conflits répétés) : ${path}`)
}

export async function putFile(path, base64, message) {
  return put(path, base64, null, message)
}

export async function deleteFile(path, message) {
  const r = await fetch(url(path), { headers: GH })
  if (r.status === 404) return
  const { sha } = await r.json()
  const d = await fetch(url(path), {
    method: 'DELETE',
    headers: { ...GH, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha }),
  })
  if (!d.ok) throw new Error(`Suppression ${path} : ${d.status}`)
}

export async function listDir(path) {
  const r = await fetch(url(path), { headers: GH })
  if (r.status === 404) return []
  if (!r.ok) throw new Error(`Liste ${path} : ${r.status}`)
  return (await r.json()).filter((e) => e.type === 'file')
}

export async function assetRedirect(id) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${id}`, {
    headers: { ...GH, Accept: 'application/octet-stream' },
    redirect: 'manual',
  })
  return { status: r.status, location: r.headers.get('location') }
}

/* ------------------------------------------------------------ session (code d'accès) */

const SECRET = process.env.APP_SECRET || ''
const sig = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
export const MAX_AGE = 60 * 60 * 24 * 180 // 6 mois

export function sessionCookie() {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE)
  return `sess=${exp}.${sig(exp)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`
}

export function checkCode(code) {
  const a = Buffer.from(String(code || '').trim().toUpperCase())
  const b = Buffer.from(String(process.env.APP_CODE || '').toUpperCase())
  return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b)
}

export function authed(req) {
  const m = /(?:^|;\s*)sess=([^;]+)/.exec(req.headers.cookie || '')
  if (!m || !SECRET) return false
  const [exp, s] = m[1].split('.')
  if (!exp || !s || Number(exp) < Date.now() / 1000) return false
  const expected = sig(exp)
  return s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))
}

export function guard(req, res) {
  if (authed(req)) return true
  res.status(401).json({ error: 'Session expirée : entre à nouveau ton code.' })
  return false
}
