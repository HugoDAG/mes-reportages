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
  { key: 'history', label: 'Analyses' },
  { key: 'settings', label: 'Réglages' },
  { key: 'guide', label: 'Mode d’emploi' },
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
  const { videos, runs, settings, platforms, queue, analyses, gh_run: ghRun } = data
  const load = reload
  // « en cours » dès que GitHub a démarré la veille, même avant que le moteur n'écrive sa progression
  const running = runs[0]?.status === 'running' || (ghRun && ghRun.status !== 'completed')
  // pendant une veille, on rafraîchit toutes les 30 s pour suivre l'analyse en direct
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => reload(), 30000)
    return () => clearInterval(t)
  }, [running])

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

      {running && tab !== 'history' && (
        <button className="live-banner" onClick={() => setTab('history')}>
          <span className="pulse" aria-hidden />
          {runs[0]?.status === 'running'
            ? <>Analyse en cours : {runs[0].done ?? 0} / {runs[0].total ?? '…'} vidéos</>
            : <>Analyse en préparation…</>}
        </button>
      )}

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
      {tab === 'history' && <><LiveRun run={runs[0]} ghRun={ghRun} onStarted={load} goGuide={() => setTab('guide')} /><AnalysisLog items={analyses || []} /><History runs={runs} /></>}
      {tab === 'settings' && settings && <><Notifications /><Platforms rows={platforms} /><SourcesManager settings={settings} onSaved={load} goGuide={() => setTab('guide')} /><Settings initial={settings} onSaved={load} /></>}
      {tab === 'guide' && <Guide goTab={setTab} />}
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
    names: lines(initial.name_variants), max_quality: initial.max_quality,
    lookback: initial.lookback, max_duration_min: initial.max_duration_min,
    tail_seconds: initial.tail_seconds, frame_interval: initial.frame_interval, threshold: initial.threshold,
    whisper_enabled: initial.whisper_enabled, face_enabled: initial.face_enabled, voice_enabled: initial.voice_enabled,
  })
  const [msg, setMsg] = useState('')
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })

  const save = async () => {
    setMsg('')
    const payload = {
      name_variants: toArr(f.names), max_quality: Number(f.max_quality) || 2160,
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
        <legend>Profondeur d’analyse</legend>
        <p className="hint">Les comptes surveillés se gèrent dans le bloc « Comptes surveillés » ci-dessus.</p>
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
  { key: 'youtube', name: 'YouTube', account: 'Indisponible en ligne', how: 'YouTube exige désormais un jeton spécial que les serveurs comme GitHub ne peuvent pas fournir : l’analyse automatique de YouTube n’est pas possible en ligne. Tes sujets BFM Marseille restent couverts par bfmtv.com. Pour inclure YouTube, il faudrait faire tourner le moteur sur un ordinateur chez toi (voir le mode d’emploi).' },
  { key: 'bfmtv', name: 'bfmtv.com', account: 'Sans compte', how: 'Lecture directe des rubriques du site.' },
  { key: 'tiktok', name: 'TikTok', account: 'Sans compte', how: 'Lecture directe des comptes publics.' },
  { key: 'instagram', name: 'Instagram', account: 'Compte requis', how: 'Un compte Instagram secondaire connecté (inutile de suivre les pages). À paramétrer plus tard.' },
  { key: 'facebook', name: 'Facebook', account: 'Par lien uniquement', how: 'Pas de surveillance automatique possible : colle le lien d’une vidéo dans Mes tournages.' },
  { key: 'x', name: 'X', account: 'Par lien uniquement', how: 'Pas de surveillance automatique possible : colle le lien d’une vidéo dans Mes tournages.' },
]

const STATUS_LABEL = { ok: 'Fonctionne', error: 'Problème', off: 'Non configuré' }
const HELP = {
  instagram: 'Bloqué ou non configuré tant que la session du compte Instagram secondaire n’est pas ajoutée.',
}

function Platforms({ rows = {} }) {
  return (
    <fieldset className="platforms">
      <legend>Plateformes</legend>
      <ul>
        {PLATFORM_INFO.map((p) => {
          const r = rows[p.key]
          const st = r?.status || (p.account === 'Par lien uniquement' ? 'link' : 'wait')
          return (
            <li key={p.key} className={`plat st-${st}`}>
              <div className="plat-head">
                <strong>{p.name}</strong>
                <span className={`acct ${p.account === 'Sans compte' ? 'free' : p.account.startsWith('Compte') ? 'need' : 'link'}`}>{p.account}</span>
              </div>
              <p className="plat-how">{p.how}</p>
              <p className="plat-state">
                {st === 'link' ? 'Ajout manuel par lien'
                  : st === 'wait' ? 'En attente du premier passage'
                  : <>{STATUS_LABEL[st]}{r?.detail ? ` : ${r.detail}` : ''}{r?.updated_at ? ` (${fmtDateTime(r.updated_at)})` : ''}</>}
              </p>
              {st !== 'ok' && HELP[p.key] && <p className="plat-help">{HELP[p.key]}</p>}
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}

/* ---------------------------------------------------------------- analyses */

const DECISIONS = {
  saved: { label: 'Retenue', cls: 'saved' },
  below: { label: 'Sous le seuil', cls: 'below' },
  too_long: { label: 'Trop longue', cls: 'muted' },
  duplicate: { label: 'Doublon', cls: 'muted' },
  error: { label: 'Erreur', cls: 'err' },
}

const ago = (d) => {
  if (!d) return ''
  const s = Math.round((Date.now() - new Date(d)) / 1000)
  if (s < 60) return 'à l’instant'
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`
  return `il y a ${Math.round(s / 3600)} h`
}

function RunButton({ onStarted, goGuide }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const start = async () => {
    setBusy(true); setMsg(null)
    try {
      await api('/api/run', { method: 'POST' })
      setMsg({ ok: true, text: 'Analyse lancée. Elle démarre dans 1 à 2 minutes, le temps que les outils s’installent.' })
      setTimeout(onStarted, 15000)
    } catch (e) {
      setMsg({ ok: false, text: e.message })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="run-btn">
      <button className="btn primary" onClick={start} disabled={busy}>{busy ? 'Lancement…' : 'Lancer une analyse maintenant'}</button>
      {msg && <p className={msg.ok ? 'saved' : 'error'} role="status">{msg.text}
        {!msg.ok && msg.text.includes('mode d’emploi') && <> <button className="link" onClick={goGuide}>Ouvrir le mode d’emploi</button></>}</p>}
    </div>
  )
}

function LiveRun({ run, ghRun, onStarted, goGuide }) {
  const preparing = ghRun && ghRun.status !== 'completed' && run?.status !== 'running'
  if (preparing) {
    return (
      <div className="live" aria-live="polite">
        <div className="live-head">
          <span className="pulse" aria-hidden />
          <strong>Analyse en préparation</strong>
          <span className="note">lancée {ago(ghRun.created_at)}</span>
        </div>
        <p className="note">Installation des outils d’analyse (visage, voix, transcription) : 2 à 5 minutes. La progression s’affichera ici ensuite.</p>
      </div>
    )
  }
  if (!run || run.status !== 'running') {
    return (
      <div className="live idle">
        {run
          ? <p><strong>Aucune analyse en cours.</strong> Dernier passage terminé {ago(run.finished_at || run.started_at)} : {run.checked} vidéos analysées, {run.found} retenue{run.found > 1 ? 's' : ''}.</p>
          : <p><strong>Aucune analyse pour l’instant.</strong></p>}
        <p className="note">Une analyse automatique a lieu tous les deux jours. Tu peux aussi en lancer une tout de suite.</p>
        <RunButton onStarted={onStarted} goGuide={goGuide} />
      </div>
    )
  }
  const total = run.total || 0
  const done = run.done || 0
  const pct = total ? Math.round((100 * done) / total) : 0
  const stale = run.updated_at && Date.now() - new Date(run.updated_at) > 20 * 60 * 1000
  return (
    <div className="live" aria-live="polite">
      <div className="live-head">
        <span className="pulse" aria-hidden />
        <strong>{run.phase || 'Analyse'}</strong>
        <span className="note">démarrée {ago(run.started_at)}</span>
      </div>
      {total > 0 && (
        <>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="live-count"><strong>{done}</strong> / {total} vidéos analysées ({pct} %), <strong>{run.found || 0}</strong> retenue{run.found > 1 ? 's' : ''}</p>
        </>
      )}
      {run.current && <p className="live-current">En cours : {run.current}</p>}
      <p className="note">
        {stale ? 'Pas de nouvelle depuis plus de 20 minutes : la veille a peut-être été interrompue.' : `Mis à jour ${ago(run.updated_at || run.started_at)}. La page se rafraîchit toute seule.`}
      </p>
    </div>
  )
}

function AnalysisLog({ items }) {
  const [filter, setFilter] = useState('all')
  const [limit, setLimit] = useState(60)
  const counts = useMemo(() => {
    const c = { all: items.length }
    items.forEach((a) => { c[a.decision] = (c[a.decision] || 0) + 1 })
    return c
  }, [items])
  const list = items.filter((a) => filter === 'all' || a.decision === filter)
  const chips = [['all', 'Toutes'], ['saved', 'Retenues'], ['below', 'Sous le seuil'], ['error', 'Erreurs']]

  return (
    <section className="alog">
      <h2 className="h2">Vidéos analysées</h2>
      {!items.length ? (
        <p className="note">Le détail de chaque vidéo analysée apparaîtra ici dès le prochain passage.</p>
      ) : (
        <>
          <div className="chips" role="group" aria-label="Filtrer">
            {chips.map(([k, l]) => (
              <button key={k} className={filter === k ? 'chip on' : 'chip'} onClick={() => { setFilter(k); setLimit(60) }}>
                {l} <span>{counts[k] || 0}</span>
              </button>
            ))}
          </div>
          <ul className="alog-list">
            {list.slice(0, limit).map((a) => {
              const d = DECISIONS[a.decision] || { label: a.decision, cls: 'muted' }
              return (
                <li key={`${a.id}-${a.at}`} className="alog-row">
                  <a className="alog-thumb" href={a.url} target="_blank" rel="noreferrer">
                    {a.thumbnail ? <img src={a.thumbnail} alt="" loading="lazy" /> : <div className="noimg" />}
                  </a>
                  <div className="alog-body">
                    <a className="alog-title" href={a.url} target="_blank" rel="noreferrer">{a.title || a.url}</a>
                    <p className="meta">{a.channel || SOURCES[a.source] || a.source}, analysée {ago(a.at)}</p>
                    {a.decision === 'error' ? (
                      <p className="alog-err">{a.error}</p>
                    ) : (
                      <p className="alog-scores">
                        Nom {a.score_name ?? 0} %, visage {a.score_face ?? 'non analysé'}{a.score_face != null ? ' %' : ''}, voix {a.score_voice ?? 'non analysée'}{a.score_voice != null ? ' %' : ''}
                      </p>
                    )}
                  </div>
                  <div className="alog-side">
                    <span className={`decision ${d.cls}`}>{d.label}</span>
                    {a.score != null && <strong className="alog-score">{a.score} %</strong>}
                  </div>
                </li>
              )
            })}
          </ul>
          {list.length > limit && <button className="btn" onClick={() => setLimit(limit + 60)}>Afficher plus</button>}
        </>
      )}
    </section>
  )
}

/* ---------------------------------------------------------------- comptes surveillés */

const SOURCE_KINDS = [
  { key: 'youtube_channels', label: 'YouTube', example: 'https://www.youtube.com/@BFM-Marseille' },
  { key: 'tiktok_accounts', label: 'TikTok', example: 'https://www.tiktok.com/@nomducompte' },
  { key: 'instagram_accounts', label: 'Instagram', example: 'https://www.instagram.com/nomducompte' },
  { key: 'pages', label: 'bfmtv.com', example: 'https://www.bfmtv.com/marseille/' },
  { key: 'rss_feeds', label: 'Flux RSS', example: 'https://…/rss.xml' },
]

const VIDEO_MSG = 'C’est le lien d’une vidéo, pas d’un compte. Pour l’ajouter, utilise « Ajouter une vidéo par son lien » dans Mes tournages.'

function detectSource(raw, forced) {
  const input = raw.trim()
  if (!input) return { error: 'Colle le lien d’un compte ou d’une chaîne.' }
  if (input.startsWith('@')) {
    const handle = input.replace(/^@+/, '')
    if (forced === 'youtube_channels') return { key: forced, value: `https://www.youtube.com/@${handle}` }
    if (forced === 'tiktok_accounts') return { key: forced, value: `@${handle}` }
    if (forced === 'instagram_accounts') return { key: forced, value: handle }
    return { error: 'Choisis la plateforme dans le menu, ou colle le lien complet du compte.' }
  }
  let u
  try { u = new URL(/^https?:\/\//.test(input) ? input : `https://${input}`) } catch { return { error: 'Ce lien n’est pas valide.' } }
  const host = u.hostname.replace(/^www\.|^m\./, '')
  const parts = u.pathname.split('/').filter(Boolean)
  if (host.endsWith('youtube.com') || host === 'youtu.be') {
    if (host === 'youtu.be' || parts[0] === 'watch' || parts[0] === 'shorts' || parts[0] === 'live') return { error: VIDEO_MSG }
    if (!parts.length) return { error: 'Colle le lien de la chaîne, par exemple https://www.youtube.com/@BFM-Marseille' }
    const base = ['channel', 'c', 'user'].includes(parts[0]) ? parts.slice(0, 2).join('/') : parts[0]
    return { key: 'youtube_channels', value: `https://www.youtube.com/${base}` }
  }
  if (host.endsWith('tiktok.com')) {
    if (parts.includes('video')) return { error: VIDEO_MSG }
    if (!parts[0]?.startsWith('@')) return { error: 'Colle le lien du compte, par exemple https://www.tiktok.com/@nomducompte' }
    return { key: 'tiktok_accounts', value: parts[0] }
  }
  if (host.endsWith('instagram.com')) {
    if (['p', 'reel', 'reels', 'tv', 'stories'].includes(parts[0])) return { error: VIDEO_MSG }
    if (!parts[0]) return { error: 'Colle le lien du compte, par exemple https://www.instagram.com/nomducompte' }
    return { key: 'instagram_accounts', value: parts[0] }
  }
  if (host.endsWith('facebook.com') || host === 'fb.watch' || host === 'x.com' || host.endsWith('twitter.com')) {
    return { error: 'Facebook et X ne peuvent pas être surveillés automatiquement. Colle plutôt le lien de chaque vidéo dans Mes tournages.' }
  }
  if (/rss|\.xml$|feed/i.test(u.pathname)) return { key: 'rss_feeds', value: u.href }
  if (host.endsWith('bfmtv.com')) {
    if (/_VN-?\d/.test(u.pathname)) return { error: VIDEO_MSG }
    return { key: 'pages', value: u.href }
  }
  return { error: 'Cette plateforme n’est pas gérée. Plateformes possibles : YouTube, TikTok, Instagram, bfmtv.com ou un flux RSS.' }
}

const sourceLink = (key, v) =>
  key === 'tiktok_accounts' ? `https://www.tiktok.com/${v.startsWith('@') ? v : '@' + v}`
    : key === 'instagram_accounts' ? `https://www.instagram.com/${v.replace(/^@/, '')}`
      : v

function SourcesManager({ settings, onSaved, goGuide }) {
  const [input, setInput] = useState('')
  const [forced, setForced] = useState('')
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  const save = async (key, list, okText) => {
    setBusy(true)
    try {
      await act({ type: 'settings', settings: { [key]: list } })
      setMsg({ ok: true, text: okText })
      await onSaved()
    } catch (e) {
      setMsg({ ok: false, text: `Enregistrement impossible : ${e.message}` })
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    const r = detectSource(input, forced)
    if (r.error) { setMsg({ ok: false, text: r.error }); return }
    const list = settings[r.key] || []
    if (list.some((x) => x.toLowerCase() === r.value.toLowerCase())) { setMsg({ ok: false, text: 'Ce compte est déjà surveillé.' }); return }
    const label = SOURCE_KINDS.find((k) => k.key === r.key).label
    await save(r.key, [...list, r.value], `${label} : ${r.value} ajouté. Il sera analysé au prochain passage.`)
    setInput('')
  }

  const remove = (key, v) => save(key, (settings[key] || []).filter((x) => x !== v), `${v} retiré.`)

  const total = SOURCE_KINDS.reduce((n, k) => n + (settings[k.key]?.length || 0), 0)

  return (
    <fieldset className="sources">
      <legend>Comptes surveillés</legend>
      <p className="hint">Colle le lien d’une chaîne ou d’un compte : la plateforme est reconnue toute seule. <button type="button" className="link" onClick={goGuide}>Où trouver ces liens ?</button></p>
      <div className="inline">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="https://www.youtube.com/@BFM-Marseille" aria-label="Lien du compte à surveiller" />
        <button type="button" className="btn primary" onClick={add} disabled={!input || busy}>Ajouter</button>
      </div>
      {input.trim().startsWith('@') && (
        <select value={forced} onChange={(e) => setForced(e.target.value)} aria-label="Plateforme" className="forced">
          <option value="">Choisis la plateforme de ce @compte</option>
          <option value="youtube_channels">YouTube</option>
          <option value="tiktok_accounts">TikTok</option>
          <option value="instagram_accounts">Instagram</option>
        </select>
      )}
      {msg && <p className={msg.ok ? 'saved' : 'error'} role="status">{msg.text}</p>}

      {!total && <p className="note">Aucun compte surveillé pour l’instant.</p>}
      {SOURCE_KINDS.filter((k) => settings[k.key]?.length).map((k) => (
        <div key={k.key} className="src-group">
          <h3 className="src-title">{k.label}</h3>
          <ul className="src-list">
            {settings[k.key].map((v) => (
              <li key={v}>
                <a href={sourceLink(k.key, v)} target="_blank" rel="noreferrer">{v.replace(/^https:\/\/(www\.)?/, '')}</a>
                <button type="button" className="link" onClick={() => remove(k.key, v)} disabled={busy}>Retirer</button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {settings.instagram_accounts?.length > 0 && (
        <p className="plat-help">Instagram ne sera analysé qu’une fois la session du compte secondaire ajoutée (voir le mode d’emploi).</p>
      )}
    </fieldset>
  )
}

/* ---------------------------------------------------------------- mode d'emploi */

function Guide({ goTab }) {
  const Go = ({ to, children }) => <button type="button" className="link" onClick={() => goTab(to)}>{children}</button>
  return (
    <article className="guide">
      <h2 className="h2">Mode d’emploi</h2>
      <p className="lead">L’app analyse toute seule, tous les deux jours, les nouvelles vidéos des comptes que tu surveilles. Chaque vidéo où elle reconnaît ton nom, ton visage ou ta voix est téléchargée et rangée dans Mes tournages.</p>

      <details open>
        <summary>Ajouter un compte à surveiller</summary>
        <p>Va dans <Go to="settings">Réglages</Go>, bloc « Comptes surveillés ». Colle le lien du compte, puis clique sur « Ajouter ». La plateforme est reconnue toute seule, et le compte est analysé au passage suivant.</p>
        <table className="guide-table">
          <thead><tr><th>Plateforme</th><th>Où trouver le lien</th><th>Exemple</th><th>Compte requis</th></tr></thead>
          <tbody>
            <tr><td>YouTube</td><td>Non analysé en ligne (voir « Si une plateforme est bloquée »).</td><td>—</td><td>Nécessite un ordinateur chez toi</td></tr>
            <tr><td>TikTok</td><td>Ouvre le profil du compte, puis Partager → Copier le lien.</td><td>tiktok.com/@nomducompte</td><td>Non</td></tr>
            <tr><td>Instagram</td><td>Ouvre le profil, puis ••• → Copier l’URL du profil.</td><td>instagram.com/nomducompte</td><td>Compte Instagram secondaire (voir plus bas)</td></tr>
            <tr><td>bfmtv.com</td><td>Ouvre la rubrique qui liste les vidéos, par exemple la page Marseille.</td><td>bfmtv.com/marseille/</td><td>Non</td></tr>
            <tr><td>Facebook, X</td><td>Pas de surveillance automatique possible.</td><td>—</td><td>Ajout par lien uniquement</td></tr>
          </tbody>
        </table>
        <p className="note">Sur téléphone, tu peux aussi taper directement « @nomducompte » : un menu te demande alors la plateforme.</p>
      </details>

      <details>
        <summary>Ajouter une vidéo précise</summary>
        <p>Dans <Go to="library">Mes tournages</Go>, colle le lien de la vidéo dans « Ajouter une vidéo par son lien ». Ça marche pour YouTube, TikTok, Instagram, Facebook, X et bfmtv.com. La vidéo est téléchargée au prochain passage et rangée directement dans tes tournages validés.</p>
      </details>

      <details>
        <summary>Visage et voix</summary>
        <p>Dans <Go to="me">Visage et voix</Go> :</p>
        <ul>
          <li>ajoute 5 à 10 photos nettes de ton visage, sous des angles et des éclairages variés ;</li>
          <li>ajoute quelques extraits de ta voix de 30 à 60 secondes, sans musique, ou enregistre-toi directement dans l’app.</li>
        </ul>
        <p>Sans ces références, seul ton nom est cherché.</p>
      </details>

      <details>
        <summary>Régler la détection</summary>
        <p>Dans <Go to="settings">Réglages</Go> :</p>
        <ul>
          <li><strong>Ton nom et ses variantes</strong> : ajoute les orthographes qu’une transcription pourrait produire.</li>
          <li><strong>Ressemblance minimale</strong> : à 70 %, c’est équilibré. Monte-la si trop de vidéos sans toi sont retenues, baisse-la si tu en rates.</li>
          <li><strong>Image analysée toutes les X secondes</strong> : 1 seconde est plus précis, mais plus lent.</li>
          <li><strong>Qualité enregistrée</strong> : jusqu’à 4K, ou 1080p pour prendre moins de place.</li>
        </ul>
      </details>

      <details>
        <summary>Suivre les analyses</summary>
        <p>L’onglet <Go to="history">Analyses</Go> montre la progression en direct, puis chaque vidéo analysée avec ses scores (nom, visage, voix) et la décision prise. Une vidéo « Sous le seuil » a été vue, mais n’a pas été jugée assez ressemblante.</p>
        <p>Pour lancer une analyse sans attendre, clique sur « Lancer une analyse maintenant » dans l’onglet Analyses.</p>
        <p className="note">Si l’app répond que le token n’a pas le droit de lancer une analyse : sur GitHub, va dans Settings → Developer settings → Fine-grained tokens, ouvre « stockage reportages » puis « Edit ». Dans « Repository access », ajoute <strong>mes-reportages</strong>. Dans « Permissions », mets <strong>Actions : Read and write</strong>. Enregistre : il n’y a rien d’autre à changer.</p>
      </details>

      <details>
        <summary>Valider et télécharger</summary>
        <ul>
          <li><Go to="pending">À vérifier</Go> : les nouvelles détections. « Valider » les garde, « Écarter » supprime le fichier.</li>
          <li><Go to="library">Mes tournages</Go> : toutes tes vidéos par année, avec « Télécharger en 4K / 1080p » et l’export de la liste en Excel.</li>
        </ul>
      </details>

      <details>
        <summary>Notifications et installation</summary>
        <ol>
          <li>Installe l’app. Sur iPhone : Safari, bouton Partager, puis « Sur l’écran d’accueil ». Sur Android : Chrome, menu, puis « Installer l’application ».</li>
          <li>Ouvre l’app depuis l’icône.</li>
          <li>Va dans Réglages, puis « Activer les notifications ».</li>
        </ol>
      </details>

      <details>
        <summary>Si une plateforme est bloquée</summary>
        <p>Réglages → Plateformes indique l’état de chaque réseau après chaque passage.</p>
        <ul>
          <li><strong>YouTube n’est pas analysé en ligne.</strong> YouTube exige maintenant un jeton spécial que les serveurs (GitHub, hébergeurs…) ne peuvent pas produire : l’analyse automatique de YouTube depuis le cloud n’est plus possible. Ce n’est pas un réglage à corriger. Tes reportages BFM Marseille restent couverts par bfmtv.com. Si tu veux vraiment inclure YouTube, il faut faire tourner le moteur sur un ordinateur chez toi ; demande-moi la marche à suivre.</li>
                    <li><strong>Mettre en place Instagram</strong> :
            <ol>
              <li>Crée un compte Instagram secondaire (inutile de suivre les pages).</li>
              <li>Connecte-toi avec sur instagram.com, depuis le profil Chrome « Reportages ».</li>
              <li>Extension Get cookies.txt LOCALLY → « Copy », puis récupère la valeur de la ligne <code>sessionid</code>.</li>
              <li>Crée deux secrets GitHub : <code>IG_SESSIONID</code> (cette valeur) et <code>IG_USERNAME</code> (le nom du compte).</li>
            </ol>
          </li>
        </ul>
      </details>
    </article>
  )
}
