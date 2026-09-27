import { useEffect, useMemo, useRef, useState } from 'react'

/* ---------------------------------------------------------------- serveur */

class AuthError extends Error {}

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => ({}))
  if (r.status === 401) throw new AuthError(data.error || 'Session expirée.')
  if (!r.ok) throw new Error(data.error || `Erreur ${r.status}`)
  return data
}
const act = (body) => api('/api/action', { method: 'POST', body })


const REASONS = {
  text: 'Nom dans le titre, la description ou l’article',
  subtitles: 'Nom dans les sous-titres',
  speech: 'Nom prononcé en fin de sujet',
  manual: 'Ajoutée à la main',
}

const SOURCES = {
  youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok', facebook: 'Facebook',
  x: 'X', bfmtv: 'bfmtv.com', manual: 'Lien ajouté',
}

// Les vidéos sont servies par /api/download, qui vérifie la session avant de rediriger vers le stockage
const fileUrl = (id) => `/api/download?id=${id}`
const downloadFile = (id) => { window.location.href = fileUrl(id) }
const qLabel = (h) => (!h ? '' : h >= 2160 ? '4K' : h >= 1440 ? '1440p' : `${h}p`)
const fmtSize = (b) => (!b ? '' : b > 1e9 ? `${(b / 1e9).toFixed(1)} Go` : `${Math.round(b / 1e6)} Mo`)

const TABS = [
  { key: 'pending', label: 'À vérifier' },
  { key: 'library', label: 'Mes tournages' },
  { key: 'rejected', label: 'Écartées' },
  { key: 'me', label: 'Visage et voix' },
  { key: 'history', label: 'Historique' },
  { key: 'settings', label: 'Réglages' },
]

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : 'Date inconnue'
const fmtDateTime = (d) =>
  d ? new Date(d).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
const fmtDur = (s) => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '')

export default function App() {
  const [state, setState] = useState('loading') // loading | in | out
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  const load = async () => {
    try {
      const d = await api('/api/data')
      d.videos.sort((a, b) => String(b.published_at || '').localeCompare(String(a.published_at || '')))
      setData(d)
      setError('')
      setState('in')
    } catch (e) {
      if (e instanceof AuthError) setState('out')
      else { setError(e.message); setState((s) => (s === 'loading' ? 'error' : s)) }
    }
  }
  useEffect(() => { load() }, [])

  if (state === 'loading') return null
  if (state === 'out') return <Login onIn={load} />
  if (state === 'error') {
    return <main className="login"><h1 className="brand">Mes reportages</h1><p className="error">{error}</p>
      <button className="btn" onClick={load}>Réessayer</button></main>
  }
  return <Dashboard data={data} setData={setData} reload={load} onOut={() => setState('out')} />
}

function Login({ onIn }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async () => {
    setError(''); setBusy(true)
    try {
      await api('/api/login', { method: 'POST', body: { code } })
      await onIn()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="login">
      <h1 className="brand">Mes reportages</h1>
      <label htmlFor="code">Code d’accès</label>
      <input id="code" value={code} autoComplete="current-password" autoCapitalize="characters"
        onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} />
      <button className="btn primary" onClick={send} disabled={!code || busy}>{busy ? 'Connexion…' : 'Se connecter'}</button>
      {error && <p className="error">{error}</p>}
      <p className="note">Tu restes connecté 6 mois sur cet appareil.</p>
    </main>
  )
}

function Dashboard({ data, setData, reload, onOut }) {
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('tab') || 'library')
  const [playing, setPlaying] = useState(null)
  const { videos, runs, settings, platforms, queue } = data
  const load = reload

  const counts = useMemo(() => {
    const c = {}
    videos.forEach((v) => { c[v.status] = (c[v.status] || 0) + 1 })
    return c
  }, [videos])

  const setStatus = async (id, status) => {
    setData((d) => ({ ...d, videos: d.videos.map((v) => (v.id === id ? { ...v, status } : v)) }))
    try { await act({ type: 'status', id, status }) } catch (e) { alert(`Modification non enregistrée : ${e.message}`); reload() }
  }

  const lastRun = runs[0]
  const names = settings?.name_variants || []

  return (
    <div className="shell">
      <header className="top">
        <h1 className="brand">Mes reportages</h1>
        <p className="status">
          {lastRun
            ? <>Dernière veille le {fmtDateTime(lastRun.started_at)} : {lastRun.checked} vidéos analysées, {lastRun.found} enregistrée{lastRun.found > 1 ? 's' : ''}
                {lastRun.status === 'error' && <span className="warn">, avec des remarques</span>}</>
            : 'La première veille n’a pas encore tourné.'}
        </p>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key}
            className={tab === t.key ? 'tab on' : 'tab'} onClick={() => setTab(t.key)}>
            {t.label}{(t.key === 'library' ? (counts.kept || 0) + (counts.pending || 0) : counts[t.key])
              ? <span className={`count ${t.key}`}>{t.key === 'library' ? (counts.kept || 0) + (counts.pending || 0) : counts[t.key]}</span> : null}
          </button>
        ))}
      </nav>

      {tab === 'pending' && (
        <>
          <AddLink queue={queue} onAdded={load} />
          <VideoList videos={videos.filter((v) => v.status === 'pending').sort((a, b) => (b.score || 0) - (a.score || 0))}
            tab="pending" names={names} onStatus={setStatus} goTab={setTab} onPlay={setPlaying} />
        </>
      )}
      {tab === 'library' && <AddLink queue={queue} onAdded={load} />}
      {tab === 'library' && <Library videos={videos.filter((v) => v.status !== 'rejected')} onStatus={setStatus} onPlay={setPlaying} />}
      {tab === 'rejected' && (
        <VideoList videos={videos.filter((v) => v.status === 'rejected')}
          tab="rejected" names={names} onStatus={setStatus} goTab={setTab} onPlay={setPlaying} />
      )}
      {tab === 'me' && <References settings={settings} />}
      {tab === 'history' && <History runs={runs} />}
      {tab === 'settings' && settings && <><Notifications /><Platforms rows={platforms} /><Settings initial={settings} onSaved={load} /></>}
      {playing && <Player v={playing} onClose={() => setPlaying(null)} />}

      <footer className="foot">
        <button className="link" onClick={async () => { await api('/api/logout', { method: 'POST' }); onOut() }}>Se déconnecter</button>
      </footer>
    </div>
  )
}

/* ---------------------------------------------------------------- jauges */

function Gauge({ label, value, hint }) {
  const off = value === null || value === undefined
  return (
    <div className={`gauge ${off ? 'off' : ''}`}>
      <span className="g-label">{label}</span>
      <span className="g-track" aria-hidden><span className="g-fill" style={{ width: `${off ? 0 : value}%` }} /></span>
      <span className="g-val">{off ? 'non analysé' : `${value} %`}</span>
      {hint && !off ? <span className="g-hint">{hint}</span> : null}
    </div>
  )
}

function Scores({ v }) {
  const level = v.score >= 85 ? 'fort' : v.score >= 60 ? 'moyen' : 'faible'
  return (
    <div className="scores">
      <div className={`global ${level}`} title="Ressemblance globale">
        <strong>{v.score ?? '—'}</strong><span>%</span>
      </div>
      <div className="gauges">
        <Gauge label="Nom" value={v.score_name} hint={v.match_type && REASONS[v.match_type]} />
        <Gauge label="Visage" value={v.score_face} hint={v.face_hits ? `vu sur ${v.face_hits} image${v.face_hits > 1 ? 's' : ''}` : null} />
        <Gauge label="Voix" value={v.score_voice} />
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- listes */

function Highlight({ text, names }) {
  if (!text) return null
  const lower = text.toLowerCase()
  for (const n of names) {
    const v = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    const i = v ? lower.indexOf(v) : -1
    if (i >= 0) return <>…{text.slice(0, i)}<mark>{text.slice(i, i + v.length)}</mark>{text.slice(i + v.length)}…</>
  }
  return <>…{text}…</>
}

function VideoCard({ v, tab, names, onStatus, onPlay }) {
  return (
    <li className="item">
      <a className="thumb" href={v.url} target="_blank" rel="noreferrer">
        {v.thumbnail ? <img src={v.thumbnail} alt="" loading="lazy" /> : <div className="noimg" />}
        {v.duration ? <span className="tc">{fmtDur(v.duration)}</span> : null}
      </a>
      <div className="body">
        <h2 className="synthe"><span>{v.title || 'Sans titre'}</span></h2>
        <p className="meta">{fmtDate(v.published_at)}, {v.channel || SOURCES[v.source] || v.source}</p>
        <Scores v={v} />
        {v.match_excerpt && <p className="excerpt"><Highlight text={v.match_excerpt} names={names} /></p>}
        {v.other_urls?.length ? (
          <p className="note">Aussi publiée ici : {v.other_urls.map((u, i) => (
            <a key={u} href={u} target="_blank" rel="noreferrer">{i ? ', ' : ''}lien {i + 1}</a>))}
          </p>
        ) : null}
        <div className="actions">
          {tab !== 'kept' && <button className="btn primary" onClick={() => onStatus(v.id, 'kept')}>Valider</button>}
          {tab !== 'rejected' && <button className="btn" onClick={() => onStatus(v.id, 'rejected')}>Écarter</button>}
          {v.file_id && <button className="btn ghost" onClick={() => onPlay(v)}>Regarder{v.file_height ? ` (${qLabel(v.file_height)})` : ''}</button>}
          <a className="btn ghost" href={v.url} target="_blank" rel="noreferrer">Voir en ligne</a>
        </div>
        {tab === 'rejected' && (
          <p className="note">{v.file_id ? 'Le fichier sera supprimé au prochain passage.' : 'Fichier supprimé.'}</p>
        )}
      </div>
    </li>
  )
}

function VideoList({ videos, tab, names, onStatus, goTab, onPlay }) {
  if (!videos.length) {
    return (
      <div className="empty">
        <p>{tab === 'pending'
          ? 'Aucune vidéo à vérifier. La veille tourne tous les deux jours.'
          : 'Les vidéos écartées apparaissent ici. Leur fichier est supprimé au passage suivant.'}</p>
        {tab === 'pending' && <button className="btn" onClick={() => goTab('me')}>Ajouter mes photos et ma voix</button>}
      </div>
    )
  }
  return (
    <ul className="list">
      {videos.map((v) => <VideoCard key={v.id} v={v} tab={tab} names={names}
        onStatus={onStatus} onPlay={onPlay} />)}
    </ul>
  )
}

function AddLink() {
  const [url, setUrl] = useState('')
  const [msg, setMsg] = useState('')
  const add = async () => {
    setMsg('')
    if (!/^https?:\/\//.test(url.trim())) { setMsg('Colle un lien complet, commençant par https://'); return }
    try {
      await act({ type: 'queue', url: url.trim() })
      setMsg('Lien ajouté. La vidéo sera téléchargée au prochain passage et rangée dans Mes tournages.')
      setUrl('')
      onAdded?.()
    } catch (e) {
      setMsg(`Ajout impossible : ${e.message}`)
    }
  }
  return (
    <div className="addlink">
      <label htmlFor="addurl">Ajouter une vidéo par son lien (Instagram, TikTok, YouTube, Facebook, X, bfmtv.com)</label>
      <div className="inline">
        <input id="addurl" type="url" value={url} onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="https://www.instagram.com/reel/…" />
        <button className="btn primary" onClick={add} disabled={!url}>Ajouter</button>
      </div>
      {msg && <p className="note" role="status">{msg}</p>}
    </div>
  )
}

/* ---------------------------------------------------------------- mes tournages */

function Downloads({ v }) {
  if (!v.file_id) {
    return <p className="note">Pas de fichier enregistré (vidéo trop longue ou en cours de traitement).</p>
  }
  return (
    <div className="dl">
      <button className="btn primary" onClick={() => downloadFile(v.file_id)}>
        Télécharger en {qLabel(v.file_height) || 'qualité max'}
      </button>
      {v.file_1080_id && (
        <button className="btn" onClick={() => downloadFile(v.file_1080_id)}>Télécharger en 1080p</button>
      )}
      <span className="size">{fmtSize(v.file_size)}</span>
    </div>
  )
}

function Library({ videos, onStatus, onPlay }) {
  const [q, setQ] = useState('')
  const [platform, setPlatform] = useState('all')
  const [state, setState] = useState('all')

  const platforms = useMemo(() => [...new Set(videos.map((v) => v.source))], [videos])

  const filtered = useMemo(() => {
    const nq = q.trim().toLowerCase()
    return videos.filter((v) =>
      (platform === 'all' || v.source === platform) &&
      (state === 'all' || v.status === state) &&
      (!nq || `${v.title} ${v.channel}`.toLowerCase().includes(nq)))
  }, [videos, q, platform, state])

  const years = useMemo(() => {
    const g = {}
    filtered.forEach((v) => {
      const y = v.published_at ? new Date(v.published_at).getFullYear() : 'Sans date'
      ;(g[y] = g[y] || []).push(v)
    })
    return Object.entries(g).sort((a, b) => String(b[0]).localeCompare(String(a[0])))
  }, [filtered])

  const total = filtered.reduce((n, v) => n + (v.file_size || 0), 0)

  const exportCsv = () => {
    const esc = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`
    const rows = [['Date', 'Chaîne', 'Plateforme', 'Titre', 'Durée', 'Qualité', 'Lien en ligne', 'Autres liens', 'Fichier']]
    filtered.forEach((v) => rows.push([
      v.published_at?.slice(0, 10), v.channel, SOURCES[v.source] || v.source, v.title, fmtDur(v.duration),
      qLabel(v.file_height), v.url, (v.other_urls || []).join(' '), v.file_name || '',
    ]))
    const blob = new Blob(['\ufeff' + rows.map((r) => r.map(esc).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `mes-tournages-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  if (!videos.length) {
    return <div className="empty"><p>Aucun tournage pour l’instant. Chaque vidéo trouvée par la veille ou ajoutée par lien apparaîtra ici, prête à télécharger.</p></div>
  }

  return (
    <div className="library">
      <div className="lib-head">
        <p><strong>{filtered.length}</strong> tournage{filtered.length > 1 ? 's' : ''}{total ? `, ${fmtSize(total)}` : ''}</p>
        <div className="actions">
          <button className="btn" onClick={exportCsv}>Exporter la liste (Excel)</button>
        </div>
      </div>

      <div className="filters">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher un sujet" aria-label="Rechercher un sujet" />
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Plateforme">
          <option value="all">Toutes les plateformes</option>
          {platforms.map((p) => <option key={p} value={p}>{SOURCES[p] || p}</option>)}
        </select>
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="État">
          <option value="all">Validés et à vérifier</option>
          <option value="kept">Validés uniquement</option>
          <option value="pending">À vérifier uniquement</option>
        </select>
      </div>

      {!filtered.length && <div className="empty"><p>Aucun tournage ne correspond à ces filtres.</p></div>}

      {years.map(([year, list]) => (
        <section key={year} className="year">
          <h2 className="year-title">{year}<span>{list.length}</span></h2>
          <ul className="book-list">
            {list.map((v) => (
              <li key={v.id} className="book-row">
                <button className="mini" onClick={() => (v.file_id ? onPlay(v) : window.open(v.url, '_blank'))}
                  aria-label={`Regarder ${v.title || 'la vidéo'}`}>
                  {v.thumbnail ? <img src={v.thumbnail} alt="" loading="lazy" /> : <div className="noimg" />}
                  {v.file_height ? <span className="badge">{qLabel(v.file_height)}</span> : null}
                </button>
                <div className="row-body">
                  <a className="book-title" href={v.url} target="_blank" rel="noreferrer">{v.title || 'Sans titre'}</a>
                  <p className="meta">
                    {fmtDate(v.published_at)}, {v.channel || SOURCES[v.source]}
                    {v.duration ? `, ${fmtDur(v.duration)}` : ''}
                    {v.status === 'pending' && <span className="pill">à vérifier</span>}
                  </p>
                  <Downloads v={v} />
                </div>
                <button className="link" onClick={() => onStatus(v.id, 'rejected')}>Retirer</button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- références */

const MAX_UPLOAD = 3 * 1024 * 1024 // limite d'envoi des fonctions Vercel (après encodage)

const toBase64 = (blob) => new Promise((ok, ko) => {
  const r = new FileReader()
  r.onload = () => ok(String(r.result).split(',')[1])
  r.onerror = ko
  r.readAsDataURL(blob)
})

// Réduit une photo à 1600 px de large en JPEG : plus léger, aussi efficace pour la reconnaissance
async function shrinkImage(file) {
  const img = await createImageBitmap(file).catch(() => null)
  if (!img) return file
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height))
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale)
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
  const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.88))
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
}

function useRefFiles(kind) {
  const [files, setFiles] = useState([])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try { setFiles(await api(`/api/refs?kind=${kind}`)) } catch (e) { setMsg(e.message) }
  }
  useEffect(() => { load() }, [])
  const upload = async (fileList) => {
    setMsg(''); setBusy(true)
    for (let f of fileList) {
      if (kind === 'face') f = await shrinkImage(f)
      if (f.size > MAX_UPLOAD) {
        setMsg(`« ${f.name} » dépasse 3 Mo. Coupe un extrait plus court (30 à 60 secondes suffisent).`)
        continue
      }
      try {
        await api('/api/refs', { method: 'POST', body: { kind, name: f.name, data: await toBase64(f) } })
      } catch (e) {
        setMsg(`Envoi de « ${f.name} » impossible : ${e.message}`)
      }
    }
    setBusy(false)
    load()
  }
  const remove = async (path) => {
    try { await api(`/api/refs?path=${encodeURIComponent(path)}`, { method: 'DELETE' }) } catch (e) { setMsg(e.message) }
    load()
  }
  return { files, upload, remove, msg, busy }
}
const refUrl = (path) => `/api/refs?path=${encodeURIComponent(path)}`

function Recorder({ onDone }) {
  const [rec, setRec] = useState(null)
  const [secs, setSecs] = useState(0)
  const [error, setError] = useState('')
  const timer = useRef(null)

  const start = async () => {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream)
      const chunks = []
      mr.ondataavailable = (e) => chunks.push(e.data)
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        clearInterval(timer.current)
        const type = mr.mimeType || 'audio/webm'
        const ext = type.includes('mp4') ? 'm4a' : 'webm'
        onDone([new File([new Blob(chunks, { type })], `enregistrement.${ext}`, { type })])
        setRec(null); setSecs(0)
      }
      mr.start()
      setRec(mr)
      timer.current = setInterval(() => setSecs((s) => {
        if (s + 1 >= 60) mr.stop()
        return s + 1
      }), 1000)
    } catch {
      setError('Micro inaccessible. Autorise-le dans les réglages du navigateur.')
    }
  }

  return (
    <div className="recorder">
      {rec
        ? <button className="btn rec on" onClick={() => rec.stop()}>Arrêter ({secs} s)</button>
        : <button className="btn rec" onClick={start}>Enregistrer ma voix</button>}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function References({ settings }) {
  const face = useRefFiles('face')
  const voice = useRefFiles('voice')
  return (
    <div className="refs">
      <section className="ref-block">
        <h2 className="h2">Ton visage</h2>
        <p className="lead">Ajoute 5 à 10 photos où ton visage est net : face, trois-quarts, en plateau et en extérieur, avec et sans lunettes si tu en portes. Des captures de tes propres sujets sont idéales.</p>
        <label className="btn upload">
          Ajouter des photos
          <input type="file" accept="image/*" multiple hidden onChange={(e) => face.upload([...e.target.files])} />
        </label>
        <ul className="photos">
          {face.files.map((f) => (
            <li key={f.name}>
              <img src={refUrl(f.path)} alt="Photo de référence" loading="lazy" />
              <button className="link" onClick={() => face.remove(f.path)}>Supprimer</button>
            </li>
          ))}
        </ul>
        {face.busy && <p className="note" role="status">Envoi en cours…</p>}
        {face.msg && <p className="error">{face.msg}</p>}
        {!face.files.length && !face.busy && <p className="note">Aucune photo pour l’instant.</p>}
      </section>

      <section className="ref-block">
        <h2 className="h2">Ta voix</h2>
        <p className="lead">Il faut 2 à 3 minutes de ta voix au total. Le plus efficace : des extraits de tes voix off (audio ou vidéo), sans musique ni autre voix. Tu peux aussi t’enregistrer ici, en lisant un texte comme au micro. Chaque fichier doit faire moins de 3 Mo : plusieurs extraits de 30 à 60 secondes valent mieux qu’un long.</p>
        <div className="actions">
          <label className="btn upload">
            Ajouter des fichiers audio ou vidéo
            <input type="file" accept="audio/*,video/*" multiple hidden onChange={(e) => voice.upload([...e.target.files])} />
          </label>
          <Recorder onDone={voice.upload} />
        </div>
        <ul className="voices">
          {voice.files.map((f) => (
            <li key={f.name}>
              <audio controls preload="none" src={refUrl(f.path)} />
              <button className="link" onClick={() => voice.remove(f.path)}>Supprimer</button>
            </li>
          ))}
        </ul>
        {voice.busy && <p className="note" role="status">Envoi en cours…</p>}
        {voice.msg && <p className="error">{voice.msg}</p>}
        {!voice.files.length && !voice.busy && <p className="note">Aucun extrait pour l’instant.</p>}
      </section>

      {settings && (!settings.face_enabled || !settings.voice_enabled) && (
        <p className="note">La reconnaissance {!settings.face_enabled ? 'du visage' : 'de la voix'} est désactivée dans les réglages.</p>
      )}
    </div>
  )
}

/* ---------------------------------------------------------------- historique */

function History({ runs }) {
  if (!runs.length) return <div className="empty"><p>Aucun passage pour l’instant. Lance le premier depuis l’onglet Actions de ton repo GitHub.</p></div>
  return (
    <ul className="runs">
      {runs.map((r) => (
        <li key={r.id} className={`run ${r.status}`}>
          <div className="run-head">
            <strong>{fmtDateTime(r.started_at)}</strong>
            <span>{r.status === 'running' ? 'En cours ou interrompu' : `${r.checked} analysées, ${r.found} enregistrée${r.found > 1 ? 's' : ''}`}</span>
          </div>
          {r.errors && <details><summary>Voir les remarques</summary><pre>{r.errors}</pre></details>}
        </li>
      ))}
    </ul>
  )
}

/* ---------------------------------------------------------------- réglages */

const lines = (a) => (a || []).join('\n')
const toArr = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean)

function Settings({ initial, onSaved }) {
  const [f, setF] = useState({
    names: lines(initial.name_variants), channels: lines(initial.youtube_channels),
    tiktok: lines(initial.tiktok_accounts), instagram: lines(initial.instagram_accounts), max_quality: initial.max_quality, pages: lines(initial.pages), feeds: lines(initial.rss_feeds),
    lookback: initial.lookback, max_duration_min: initial.max_duration_min,
    tail_seconds: initial.tail_seconds, frame_interval: initial.frame_interval, threshold: initial.threshold,
    whisper_enabled: initial.whisper_enabled, face_enabled: initial.face_enabled, voice_enabled: initial.voice_enabled,
  })
  const [msg, setMsg] = useState('')
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  const save = async () => {
    setMsg('')
    const payload = {
      name_variants: toArr(f.names), youtube_channels: toArr(f.channels), tiktok_accounts: toArr(f.tiktok), instagram_accounts: toArr(f.instagram), max_quality: Number(f.max_quality) || 2160,
      pages: toArr(f.pages), rss_feeds: toArr(f.feeds),
      lookback: Number(f.lookback) || 200, max_duration_min: Number(f.max_duration_min) || 20,
      tail_seconds: Number(f.tail_seconds) || 60, frame_interval: Number(f.frame_interval) || 2,
      threshold: Number(f.threshold) || 70,
      whisper_enabled: f.whisper_enabled, face_enabled: f.face_enabled, voice_enabled: f.voice_enabled,
    }
    try {
      await act({ type: 'settings', settings: payload })
      setMsg('Réglages enregistrés. Ils s’appliquent au prochain passage.')
      onSaved()
    } catch (e) {
      setMsg(`Enregistrement impossible : ${e.message}`)
    }
  }

  return (
    <form className="settings" onSubmit={(e) => { e.preventDefault(); save() }}>
      <fieldset>
        <legend>Qui chercher</legend>
        <label htmlFor="names">Ton nom et ses variantes, un par ligne</label>
        <textarea id="names" rows={4} value={f.names} onChange={set('names')} />
        <p className="hint">Les variantes aident quand la transcription écorche le nom.</p>
      </fieldset>

      <fieldset>
        <legend>Comment reconnaître</legend>
        <label className="check"><input type="checkbox" checked={f.face_enabled} onChange={set('face_enabled')} />Reconnaître mon visage</label>
        <label className="check"><input type="checkbox" checked={f.voice_enabled} onChange={set('voice_enabled')} />Reconnaître ma voix</label>
        <label className="check"><input type="checkbox" checked={f.whisper_enabled} onChange={set('whisper_enabled')} />Écouter la fin des sujets pour repérer mon nom prononcé</label>
        <label htmlFor="threshold">Ressemblance minimale pour enregistrer une vidéo : {f.threshold} %</label>
        <input id="threshold" type="range" min="30" max="95" step="5" value={f.threshold} onChange={set('threshold')} />
        <p className="hint">Plus bas, tu rates moins de vidéos mais tu en écartes plus à la main. 70 % est un bon départ.</p>
        <div className="row">
          <div>
            <label htmlFor="frame">Une image analysée toutes les (secondes)</label>
            <input id="frame" type="number" min="1" max="10" step="0.5" value={f.frame_interval} onChange={set('frame_interval')} />
          </div>
          <div>
            <label htmlFor="tail">Fin de sujet écoutée (secondes)</label>
            <input id="tail" type="number" min="20" max="180" value={f.tail_seconds} onChange={set('tail_seconds')} />
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Où chercher</legend>
        <p className="hint">Les sources sont examinées dans cet ordre : mets en premier celles où tu publies le plus.</p>
        <label htmlFor="channels">Chaînes YouTube</label>
        <textarea id="channels" rows={3} value={f.channels} onChange={set('channels')} />
        <label htmlFor="instagram">Comptes Instagram (ex. @bfmmarseille)</label>
        <textarea id="instagram" rows={2} value={f.instagram} onChange={set('instagram')} />
        <label htmlFor="tiktok">Comptes TikTok (ex. @bfmmarseille)</label>
        <textarea id="tiktok" rows={2} value={f.tiktok} onChange={set('tiktok')} />
        <label htmlFor="pages">Rubriques de sites (pages listant des vidéos)</label>
        <textarea id="pages" rows={2} value={f.pages} onChange={set('pages')} />
        <label htmlFor="feeds">Flux RSS</label>
        <textarea id="feeds" rows={2} value={f.feeds} onChange={set('feeds')} placeholder="https://www.bfmtv.com/rss/…" />
        <div className="row">
          <div>
            <label htmlFor="lookback">Vidéos récentes examinées par chaîne</label>
            <input id="lookback" type="number" min="20" max="1000" value={f.lookback} onChange={set('lookback')} />
          </div>
          <div>
            <label htmlFor="maxd">Durée maximale d’une vidéo (min)</label>
            <input id="maxd" type="number" min="1" max="180" value={f.max_duration_min} onChange={set('max_duration_min')} />
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Rangement</legend>
        <label htmlFor="quality">Qualité enregistrée</label>
        <select id="quality" value={f.max_quality} onChange={set('max_quality')}>
          <option value="2160">La meilleure disponible, jusqu’à 4K (+ une copie 1080p si 4K)</option>
          <option value="1080">1080p maximum (prend moins de place)</option>
        </select>
        <p className="hint">La 4K n’est possible que si la chaîne a publié la vidéo en 4K. Sinon, c’est la meilleure qualité publiée, le plus souvent 1080p.</p>
      </fieldset>

      <button className="btn primary" type="submit">Enregistrer les réglages</button>
      {msg && <p className="saved" role="status">{msg}</p>}
    </form>
  )
}

/* ---------------------------------------------------------------- lecteur */

function Player({ v, onClose }) {
  const src = fileUrl(v.file_id)
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="player" role="dialog" aria-modal="true" aria-label={v.title || 'Vidéo'} onClick={onClose}>
      <div className="player-box" onClick={(e) => e.stopPropagation()}>
        {src ? <video src={src} controls autoPlay playsInline /> : <div className="player-wait">Chargement…</div>}
        <div className="player-bar">
          <strong>{v.title || 'Sans titre'}</strong>
          <button className="btn" onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- notifications */

const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY

function b64ToUint8(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

function Notifications() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  const [state, setState] = useState(supported ? Notification.permission : 'unsupported')
  const [msg, setMsg] = useState('')

  const enable = async () => {
    setMsg('')
    try {
      const perm = await Notification.requestPermission()
      setState(perm)
      if (perm !== 'granted') { setMsg('Notifications refusées. Tu peux les réactiver dans les réglages du téléphone.'); return }
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(VAPID) })
      const json = sub.toJSON()
      await act({ type: 'push', subscription: json, user_agent: navigator.userAgent })
      setMsg('Notifications activées sur cet appareil.')
    } catch (e) {
      setMsg(`Activation impossible : ${e.message}`)
    }
  }

  return (
    <fieldset className="notif">
      <legend>Notifications</legend>
      {isIOS && !standalone ? (
        <p className="hint">Sur iPhone, installe d’abord l’app : bouton Partager, puis « Sur l’écran d’accueil ». Ouvre-la depuis l’icône et reviens ici.</p>
      ) : !supported ? (
        <p className="hint">Ce navigateur ne gère pas les notifications. Installe l’app sur l’écran d’accueil depuis Safari (iPhone) ou Chrome (Android).</p>
      ) : (
        <>
          <p className="hint">Reçois une notification à chaque nouveau tournage trouvé.</p>
          <button type="button" className="btn primary" onClick={enable}>
            {state === 'granted' ? 'Réactiver sur cet appareil' : 'Activer les notifications'}
          </button>
        </>
      )}
      {msg && <p className="note" role="status">{msg}</p>}
    </fieldset>
  )
}

/* ---------------------------------------------------------------- plateformes */

const PLATFORM_INFO = [
  { key: 'youtube', name: 'YouTube', account: 'Sans compte', how: 'Lecture directe des chaînes publiques. Un compte secondaire ne sert qu’en secours si YouTube bloque.' },
  { key: 'bfmtv', name: 'bfmtv.com', account: 'Sans compte', how: 'Lecture directe des rubriques du site.' },
  { key: 'tiktok', name: 'TikTok', account: 'Sans compte', how: 'Lecture directe des comptes publics.' },
  { key: 'instagram', name: 'Instagram', account: 'Compte requis', how: 'Un compte Instagram secondaire connecté (inutile de suivre les pages). À paramétrer plus tard.' },
  { key: 'facebook', name: 'Facebook', account: 'Par lien uniquement', how: 'Pas de surveillance automatique possible : colle le lien d’une vidéo dans Mes tournages.' },
  { key: 'x', name: 'X', account: 'Par lien uniquement', how: 'Pas de surveillance automatique possible : colle le lien d’une vidéo dans Mes tournages.' },
]

const STATUS_LABEL = { ok: 'Fonctionne', error: 'Problème', off: 'Non configuré' }

function Platforms({ rows = {} }) {
  return (
    <fieldset className="platforms">
      <legend>Plateformes</legend>
      <ul>
        {PLATFORM_INFO.map((p) => {
          const r = rows[p.key]
          const st = r?.status || (p.account === 'Par lien uniquement' ? 'link' : 'wait')
          return (
            <li key={p.key} className={`plat ${st}`}>
              <div className="plat-head">
                <strong>{p.name}</strong>
                <span className={`acct ${p.account === 'Sans compte' ? 'free' : p.account === 'Compte requis' ? 'need' : 'link'}`}>{p.account}</span>
              </div>
              <p className="plat-how">{p.how}</p>
              <p className="plat-state">
                {st === 'link' ? 'Ajout manuel par lien'
                  : st === 'wait' ? 'En attente du premier passage'
                  : <>{STATUS_LABEL[st]}{r?.detail ? ` : ${r.detail}` : ''}{r?.updated_at ? ` (${fmtDateTime(r.updated_at)})` : ''}</>}
              </p>
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}
