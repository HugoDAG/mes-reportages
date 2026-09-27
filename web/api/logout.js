export default function handler(req, res) {
  res.setHeader('Set-Cookie', 'sess=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')
  res.json({ ok: true })
}
