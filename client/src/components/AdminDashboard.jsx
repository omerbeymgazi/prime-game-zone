import { useCallback, useEffect, useState } from 'react'
import './AdminDashboard.css'

const API_BASE = `${(import.meta.env.VITE_API_URL || '').replace(/\/+$/, '')}/api`
const WEEK_LABELS = ['Week 1 · Prime Clash', 'Week 2 · Mid-Month Showdown', 'Week 3 · Ethiopia Elite Series', 'Week 4 · Final Whistle Cup']

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`)
  return data
}

function downloadRosterCsv(roster, weekId) {
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`
  const rows = [
    ['Slot', 'Player name', 'Contact', 'PSN ID', 'Confirmation code'],
    ...roster.map((player, index) => [
      index + 1,
      player?.playerName || '',
      player?.contact || '',
      player?.psnId || '',
      player?.confirmationCode || '',
    ]),
  ]
  const csv = rows.map((row) => row.map(quote).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `prime-gaming-week-${weekId + 1}-roster.csv`
  link.click()
  URL.revokeObjectURL(url)
}

export default function AdminDashboard() {
  const [authenticated, setAuthenticated] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)
  const [credentials, setCredentials] = useState({ username: '', password: '' })
  const [weeks, setWeeks] = useState([])
  const [registrations, setRegistrations] = useState([])
  const [roster, setRoster] = useState([])
  const [selectedWeek, setSelectedWeek] = useState(0)
  const [activeView, setActiveView] = useState('weeks')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState('')

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [weekData, registrationData] = await Promise.all([
        request('/admin/weeks'),
        request('/admin/registrations'),
      ])
      setWeeks(weekData.weeks)
      setRegistrations(registrationData.registrations)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    request('/admin/session')
      .then(async () => {
        if (!active) return
        setAuthenticated(true)
        await loadDashboard()
        setCheckingSession(false)
      })
      .catch((requestError) => {
        if (!active) return
        if (!/sign-in is required/i.test(requestError.message)) setError(requestError.message)
        setCheckingSession(false)
      })
    return () => { active = false }
  }, [loadDashboard])

  useEffect(() => {
    if (!authenticated || activeView !== 'roster') return
    let active = true
    request(`/admin/roster/${selectedWeek}`)
      .then((data) => {
        if (active) setRoster(data.roster)
      })
      .catch((requestError) => {
        if (active) setError(requestError.message)
      })
    return () => { active = false }
  }, [authenticated, activeView, selectedWeek])

  async function signIn(event) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      await request('/admin/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      })
      setCredentials({ username: '', password: '' })
      setAuthenticated(true)
      await loadDashboard()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }

  async function signOut() {
    setError('')
    try {
      await request('/admin/session', { method: 'DELETE' })
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setAuthenticated(false)
      setWeeks([])
      setRegistrations([])
      setRoster([])
    }
  }

  async function saveWeek(week) {
    setBusyId(`week-${week.weekId}`)
    setError('')
    setNotice('')
    try {
      const data = await request(`/admin/weeks/${week.weekId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          availableSlots: Number(week.availableSlots),
          status: week.status,
        }),
      })
      setWeeks((current) => current.map((item) => item.weekId === week.weekId ? data.week : item))
      setNotice(`${WEEK_LABELS[week.weekId]} updated.`)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusyId('')
    }
  }

  async function reviewRegistration(registration, decision) {
    setBusyId(registration.id)
    setError('')
    setNotice('')
    try {
      await request(`/admin/registrations/${registration.id}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      })
      setNotice(`Payment ${decision}.`)
      await loadDashboard()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusyId('')
    }
  }

  if (checkingSession) {
    return <main className="admin-shell"><p className="admin-loading">Checking secure admin session…</p></main>
  }

  if (!authenticated) {
    return (
      <main className="admin-shell">
        <form className="admin-login-card" onSubmit={signIn}>
          <a className="admin-back-link" href="/">← PRIME GAMING</a>
          <span className="admin-kicker">SECURE ORGANIZER ACCESS</span>
          <h1>Admin sign in</h1>
          <p>Use the organizer credentials configured on the server.</p>
          <label htmlFor="admin-username">Username</label>
          <input id="admin-username" autoComplete="username" value={credentials.username} onChange={(event) => setCredentials({ ...credentials, username: event.target.value })} required />
          <label htmlFor="admin-password">Password</label>
          <input id="admin-password" type="password" autoComplete="current-password" value={credentials.password} onChange={(event) => setCredentials({ ...credentials, password: event.target.value })} required />
          {error && <p className="admin-error" role="alert">{error}</p>}
          <button className="admin-primary" type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign in securely'}</button>
        </form>
      </main>
    )
  }

  const visibleRegistrations = registrations.filter((item) => item.weekId === selectedWeek)

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div><span className="admin-kicker">PRIME GAMING · ORGANIZER</span><h1>Admin dashboard</h1></div>
        <div className="admin-header-actions">
          <a href="/">Open app</a>
          <button type="button" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <nav className="admin-tabs" aria-label="Admin sections">
        {[['weeks', 'Tournaments'], ['registrations', 'Payments'], ['roster', 'Player roster']].map(([view, label]) => (
          <button type="button" key={view} className={activeView === view ? 'admin-tab admin-tab--active' : 'admin-tab'} onClick={() => setActiveView(view)}>{label}</button>
        ))}
      </nav>

      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      {loading && <p className="admin-loading">Loading organizer data…</p>}

      {activeView === 'weeks' && (
        <section className="admin-week-grid" aria-label="Weekly tournament settings">
          {weeks.map((week) => (
            <article className={`admin-week-card admin-week-card--${week.theme}`} key={week.weekId}>
              <span className="admin-kicker">WEEK {week.weekId + 1} · {week.dateRange}</span>
              <h2>{week.name}</h2>
              <label htmlFor={`slots-${week.weekId}`}>Available slots</label>
              <input id={`slots-${week.weekId}`} type="number" min="0" max={week.capacity} value={week.availableSlots} onChange={(event) => setWeeks((current) => current.map((item) => item.weekId === week.weekId ? { ...item, availableSlots: event.target.value } : item))} />
              <label htmlFor={`status-${week.weekId}`}>Tournament status</label>
              <select id={`status-${week.weekId}`} value={week.status} onChange={(event) => setWeeks((current) => current.map((item) => item.weekId === week.weekId ? { ...item, status: event.target.value } : item))}>
                <option value="open">Open</option><option value="full">Full</option><option value="completed">Completed</option>
              </select>
              <button className="admin-primary" type="button" disabled={busyId === `week-${week.weekId}`} onClick={() => saveWeek(week)}>{busyId === `week-${week.weekId}` ? 'Saving…' : 'Save changes'}</button>
            </article>
          ))}
        </section>
      )}

      {activeView === 'registrations' && (
        <section className="admin-section">
          <div className="admin-section-heading">
            <div><span className="admin-kicker">PAYMENT REVIEW</span><h2>Player registrations</h2></div>
            <select aria-label="Filter registrations by week" value={selectedWeek} onChange={(event) => setSelectedWeek(Number(event.target.value))}>
              {WEEK_LABELS.map((label, index) => <option key={label} value={index}>{label}</option>)}
            </select>
          </div>
          {visibleRegistrations.length === 0 && !loading && <p className="admin-empty">No registrations for this week yet.</p>}
          <div className="admin-registration-list">
            {visibleRegistrations.map((registration) => (
              <article className="admin-registration-card" key={registration.id}>
                <div className="admin-registration-heading"><div><h3>{registration.playerName}</h3><span>{registration.confirmationCode}</span></div><span className={`admin-status admin-status--${registration.paymentStatus}`}>{registration.paymentStatus}</span></div>
                <dl><div><dt>Phone / Contact</dt><dd>{registration.contact}</dd></div><div><dt>PSN ID</dt><dd>{registration.psnId || 'Not provided'}</dd></div><div><dt>Tournament</dt><dd>{WEEK_LABELS[registration.weekId]}</dd></div><div><dt>Payment</dt><dd>{registration.payment}</dd></div></dl>
                {registration.receiptData ? <a className="admin-receipt" href={registration.receiptData} target="_blank" rel="noreferrer">View payment receipt <img src={registration.receiptData} alt="Uploaded payment receipt" /></a> : <span className="admin-no-receipt">No receipt uploaded</span>}
                {registration.paymentStatus === 'pending' && <div className="admin-actions"><button className="admin-approve" type="button" disabled={busyId === registration.id} onClick={() => reviewRegistration(registration, 'approved')}>Approve payment</button><button className="admin-reject" type="button" disabled={busyId === registration.id} onClick={() => reviewRegistration(registration, 'rejected')}>Reject payment</button></div>}
              </article>
            ))}
          </div>
        </section>
      )}

      {activeView === 'roster' && (
        <section className="admin-section">
          <div className="admin-section-heading">
            <div><span className="admin-kicker">APPROVED PLAYERS</span><h2>32-slot match roster</h2></div>
            <div className="admin-roster-controls">
              <select aria-label="Select roster week" value={selectedWeek} onChange={(event) => setSelectedWeek(Number(event.target.value))}>
                {WEEK_LABELS.map((label, index) => <option key={label} value={index}>{label}</option>)}
              </select>
              <button type="button" className="admin-secondary" onClick={() => downloadRosterCsv(roster, selectedWeek)}>Export CSV</button>
            </div>
          </div>
          <div className="admin-roster-grid">
            {roster.map((player, index) => (
              <article className={player ? 'admin-roster-slot admin-roster-slot--filled' : 'admin-roster-slot'} key={index}>
                <strong>{String(index + 1).padStart(2, '0')}</strong>
                <span>{player?.playerName || 'Open slot'}</span>
                {player && <small>{player.psnId || player.contact}</small>}
              </article>
            ))}
          </div>
        </section>
      )}
    </main>
  )
}
