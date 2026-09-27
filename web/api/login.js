import { checkCode, sessionCookie } from './_lib.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  if (!checkCode(req.body?.code)) {
    await new Promise((ok) => setTimeout(ok, 800)) // freine les essais en série
    return res.status(401).json({ error: 'Code incorrect.' })
  }
  res.setHeader('Set-Cookie', sessionCookie())
  res.json({ ok: true })
}
