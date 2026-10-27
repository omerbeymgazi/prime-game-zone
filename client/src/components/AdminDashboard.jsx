import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './AdminDashboard.css'
import './AdminPayments.css'
import AdminChatManager from './AdminChatManager.jsx'
import { AdminDisputesPanel, AdminFinancePanel } from './AdminModules.jsx'
import ChatBackgroundPicker from './ChatBackgroundPicker.jsx'
import { apiRequest } from '../api.js'

const API_BASE = '/api'

async function request(path, options = {}) {
  return apiRequest(`${API_BASE}${path}`, options)
}

function downloadRosterCsv(roster, tournament) {
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`
  const rows = [
    ['Slot', 'Player name', 'Player code', 'Contact', 'Telegram username', 'Confirmation code'],
    ...roster.filter(Boolean).map((player, index) => [
      index + 1,
      player.playerName,
      player.playerCode,
      player.contact,
      player.telegramUsername ? `@${player.telegramUsername.replace(/^@/, '')}` : '',
      player.confirmationCode,
    ]),
  ]
  const csv = rows.map((row) => row.map(quote).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${tournament.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-roster.csv`
  link.click()
  URL.revokeObjectURL(url)
}

function tournamentForm(tournament) {
  const pool = tournament?.prizePool ?? 20000
  const first = Math.round(pool * 0.5)
  const second = Math.round(pool * 0.25)
  const third = Math.round(pool * 0.15)
  return tournament
    ? {
        dateRange: tournament.dateRange,
        capacity: String(tournament.capacity),
        entryFee: String(tournament.entryFee ?? 1500),
        prizeTiers: (tournament.prizeTiers || [first, second, third, pool - first - second - third]
          .map((amount, index) => ({ rank: index + 1, amount, reward: '' })))
          .map((tier) => ({ ...tier, amount: String(tier.amount) })),
        type: tournament.type || 'weekly',
        format: tournament.format || 'knockout',
        status: tournament.status,
      }
    : {
        dateRange: '',
        capacity: '32',
        entryFee: '1500',
        prizeTiers: [10000, 5000, 3000, 2000].map((amount, index) => ({ rank: index + 1, amount: String(amount), reward: '' })),
        type: 'weekly',
        format: 'knockout',
        status: 'upcoming',
      }
}

function localDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

function StatusBadge({ status }) {
  return <span className={`admin-status admin-status--${status}`}>{status}</span>
}

function MatchCard({ match, onSelect }) {
  const playerName = (player) => player?.playerName || (player ? 'Player' : 'TBD')
  return (
    <button
      className={`admin-match-card${match.status === 'finished' ? ' admin-match-card--finished' : ''}`}
      type="button"
      onClick={() => match.status !== 'bye' && match.player1 && match.player2 && onSelect(match)}
      disabled={match.status === 'bye' || !match.player1 || !match.player2}
    >
      <span className="admin-match-topline">
        <span>Match {match.matchNumber}</span>
        <StatusBadge status={match.status} />
      </span>
      <span className={`admin-match-player${String(match.winnerId || '') === String(match.player1Id || '') && match.winnerId ? ' admin-match-player--winner' : ''}`}>
        <span>{playerName(match.player1)}</span>
        <strong>{match.score1 ?? '—'}</strong>
      </span>
      <span className={`admin-match-player${String(match.winnerId || '') === String(match.player2Id || '') && match.winnerId ? ' admin-match-player--winner' : ''}`}>
        <span>{playerName(match.player2)}</span>
        <strong>{match.score2 ?? '—'}</strong>
      </span>
      {match.status !== 'bye' && match.player1 && match.player2 && <span className="admin-match-hint">Edit score & match</span>}
      {match.scheduledAt && <span className="admin-match-schedule">{new Date(match.scheduledAt).toLocaleString()}</span>}
      {match.location && <span className="admin-match-schedule">{match.location}</span>}
      {match.status === 'pending' && (!match.player1 || !match.player2) && <span className="admin-match-hint">Waiting for previous round</span>}
      {(match.status === 'bye' || (match.status === 'finished' && (!match.player1 || !match.player2))) && <span className="admin-match-hint">Automatic bye</span>}
    </button>
  )
}

export default function AdminDashboard() {
  const [authenticated, setAuthenticated] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)
  const [credentials, setCredentials] = useState({ username: '', password: '' })
  const [tournaments, setTournaments] = useState([])
  const [registrations, setRegistrations] = useState([])
  const [paymentGroups, setPaymentGroups] = useState([])
  const [paymentAccounts, setPaymentAccounts] = useState([
    { type: 'cbe', name: '', number: '' },
    { type: 'telebirr', name: '', number: '' },
  ])
  const [rejectionReasons, setRejectionReasons] = useState({})
  const [roster, setRoster] = useState([])
  const [matches, setMatches] = useState([])
  const [standings, setStandings] = useState([])
  const [players, setPlayers] = useState([])
  const [notificationMode, setNotificationMode] = useState('broadcast')
  const [notificationPlayerId, setNotificationPlayerId] = useState('')
  const [notificationForm, setNotificationForm] = useState({ title: '', description: '' })
  const [bracketTournamentId, setBracketTournamentId] = useState(null)
  const [selectedTournamentId, setSelectedTournamentId] = useState(null)
  const [activeView, setActiveView] = useState('tournaments')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState('')
  const [tournamentDialog, setTournamentDialog] = useState(null)
  const [tournamentDetails, setTournamentDetails] = useState(tournamentForm(null))
  const [playerDialog, setPlayerDialog] = useState(false)
  const [playerDetails, setPlayerDetails] = useState({ playerName: '', contact: '', telegramUsername: '' })
  const [matchDialog, setMatchDialog] = useState(null)
  const [matchDetails, setMatchDetails] = useState({ status: 'pending', score1: '', score2: '', scheduledAt: '', location: '' })
  const approvalIdsRef = useRef('')

  const selectedTournament = tournaments.find((item) => item.weekId === selectedTournamentId) || null
  const pendingPayments = useMemo(
    () => registrations.filter((registration) => registration.paymentStatus === 'pending'),
    [registrations],
  )
  const selectedRegistrations = registrations.filter(
    (registration) => registration.weekId === selectedTournamentId,
  )

  const loadDashboard = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [tournamentData, registrationData, paymentData, accountsData] = await Promise.all([
        request('/admin/tournaments'),
        request('/admin/registrations'),
        request('/admin/payment-groups'),
        request('/payment-accounts'),
      ])
      setTournaments(tournamentData.tournaments)
      setRegistrations(registrationData.registrations)
      approvalIdsRef.current = registrationData.registrations
        .filter((registration) => registration.paymentStatus === 'pending')
        .map((registration) => registration.id)
        .sort()
        .join(',')
      setPaymentGroups(paymentData.groups || [])
      setPaymentAccounts(accountsData.accounts || [])
      setSelectedTournamentId((current) => (
        tournamentData.tournaments.some((item) => item.weekId === current)
          ? current
          : tournamentData.tournaments[0]?.weekId ?? null
      ))
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshApprovals = useCallback(async () => {
    try {
      const registrationData = await request('/admin/registrations?summary=1')
      const registrationIds = registrationData.registrations
        .filter((registration) => registration.paymentStatus === 'pending')
        .map((registration) => registration.id)
        .sort()
        .join(',')
      setRegistrations((current) => {
        const existing = new Map(current.map((registration) => [String(registration.id), registration]))
        return registrationData.registrations.map((registration) => ({
          ...registration,
          receiptData: existing.get(String(registration.id))?.receiptData || '',
        }))
      })
      if (registrationIds !== approvalIdsRef.current) {
        approvalIdsRef.current = registrationIds
        const paymentData = await request('/admin/payment-groups')
        setPaymentGroups(paymentData.groups || [])
      }
    } catch (requestError) {
      setError(requestError.message)
    }
  }, [])

  useEffect(() => {
    let active = true
    request('/admin/session')
      .then(async () => {
        if (!active) return
        setAuthenticated(true)
        await loadDashboard()
      })
      .catch((requestError) => {
        if (!active) return
        if (!/sign-in is required/i.test(requestError.message)) setError(requestError.message)
      })
      .finally(() => {
        if (active) setCheckingSession(false)
      })
    return () => { active = false }
  }, [loadDashboard])

  useEffect(() => {
    if (!authenticated) return undefined
    const timer = window.setInterval(refreshApprovals, 10_000)
    return () => window.clearInterval(timer)
  }, [authenticated, refreshApprovals])

  useEffect(() => {
    if (!authenticated || activeView !== 'players' || selectedTournamentId === null) return
    let active = true
    request(`/admin/roster/${selectedTournamentId}`)
      .then((data) => {
        if (active) setRoster(data.roster)
      })
      .catch((requestError) => {
        if (active) setError(requestError.message)
      })
    return () => { active = false }
  }, [authenticated, activeView, selectedTournamentId, registrations])

  useEffect(() => {
    if (!authenticated || activeView !== 'notifications') return
    let active = true
    request('/admin/players')
      .then((data) => {
        if (!active) return
        setPlayers(data.players)
        setNotificationPlayerId((current) => current || data.players[0]?.id || '')
      })
      .catch((requestError) => {
        if (active) setError(requestError.message)
      })
    return () => { active = false }
  }, [authenticated, activeView])

  useEffect(() => {
    if (!authenticated || selectedTournamentId === null) return
    let active = true
    request(`/admin/tournaments/${selectedTournamentId}/fixtures`)
      .then((data) => {
        if (active) {
          setBracketTournamentId(selectedTournamentId)
          setMatches(data.matches)
          setStandings(data.standings)
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError.message)
      })
    return () => { active = false }
  }, [authenticated, selectedTournamentId, registrations])

  useEffect(() => {
    if (!tournamentDialog && !playerDialog && !matchDialog) return
    function closeOnEscape(event) {
      if (event.key !== 'Escape') return
      setTournamentDialog(null)
      setPlayerDialog(false)
      setMatchDialog(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [tournamentDialog, playerDialog, matchDialog])

  async function signIn(event) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      await request('/admin/login', { method: 'POST', body: JSON.stringify(credentials) })
      await request('/admin/session')
      setCredentials({ username: '', password: '' })
      setAuthenticated(true)
      await loadDashboard()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
      setCheckingSession(false)
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
      setTournaments([])
      setRegistrations([])
      setRoster([])
      setMatches([])
      setStandings([])
      setBracketTournamentId(null)
    }
  }

  async function saveTournament(event) {
    event.preventDefault()
    if (!tournamentDetails) return
    const editing = tournamentDialog !== 'new'
    const id = editing ? tournamentDialog.weekId : null
    const payload = {
      ...tournamentDetails,
      capacity: Number(tournamentDetails.capacity),
      entryFee: Number(tournamentDetails.entryFee),
      prizeTiers: tournamentDetails.prizeTiers.map((tier, index) => ({
        rank: index + 1,
        amount: Number(tier.amount),
        reward: tier.reward.trim(),
      })),
      prizePool: tournamentDetails.prizeTiers.reduce((sum, tier) => sum + Number(tier.amount || 0), 0),
    }
    setBusyId('tournament-save')
    setError('')
    setNotice('')
    try {
      const data = await request(
        editing ? `/admin/tournaments/${id}` : '/admin/tournaments',
        { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      )
      if (!editing) setSelectedTournamentId(data.tournament.weekId)
      setTournamentDialog(null)
      await loadDashboard()
      setNotice(`Tournament ${editing ? 'updated' : 'created'} successfully.`)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusyId('')
    }
  }

  async function deleteTournament(tournament) {
    const confirmed = window.confirm(
      `Permanently delete “${tournament.name}”, its fixtures, and all ${tournament.playerCount || 0} registrations? This cannot be undone.`,
    )
    if (!confirmed) return
    setBusyId(`tournament-${tournament.weekId}`)
    setError('')
    setNotice('')
    try {
      await request(`/admin/tournaments/${tournament.weekId}`, { method: 'DELETE' })
      await loadDashboard()
      setMatches([])
      setStandings([])
      setBracketTournamentId(null)
      setNotice('Tournament and its registrations were deleted.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusyId('')
    }
  }

  async function reviewPaymentGroup(group, decision) {
    const reason = (rejectionReasons[group.id] || '').trim()
    if (decision === 'rejected' && !reason) {
      setError('Enter a rejection reason before rejecting this payment.')
      return
    }
    setBusyId(group.id)
    setError('')
    setNotice('')
    try {
      await request(`/admin/payment-groups/${encodeURIComponent(group.paymentGroupId || group.id)}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason }),
      })
      await loadDashboard()
      setNotice(decision === 'approved' ? 'Payment approved. Digital passes have been issued.' : 'Payment rejected and the reason was sent to the player.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusyId('')
    }
  }

  async function savePaymentAccounts(event) {
    event.preventDefault()
    setBusyId('payment-accounts')
    setError('')
    setNotice('')
    try {
      await request('/admin/payment-accounts', {
        method: 'PUT',
        body: JSON.stringify({ accounts: paymentAccounts }),
      })
      setNotice('CBE and Telebirr payment accounts updated.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusyId('')
    }
  }

  async function addPlayer(event) {
    event.preventDefault()
    if (!selectedTournament) return
    setBusyId('player-add')
    setError('')
    try {
      await request(`/admin/tournaments/${selectedTournament.weekId}/players`, {
        method: 'POST',
        body: JSON.stringify(playerDetails),
      })
      setPlayerDetails({ playerName: '', contact: '', telegramUsername: '' })
      setPlayerDialog(false)
      await loadDashboard()
      setNotice('Player added to the approved roster.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusyId('')
    }
  }

  async function removePlayer(player) {
    if (!selectedTournament) return
    const isApproved = player.paymentStatus === 'approved'
    const message = isApproved
      ? `Remove ${player.playerName} from ${selectedTournament.name}? Any unplayed draw will be reset.`
      : `Remove ${player.playerName}'s ${player.paymentStatus} entry from ${selectedTournament.name}?`
    if (!window.confirm(message)) return
    setBusyId(player.id)
    setError('')
    try {
      await request(`/admin/tournaments/${selectedTournament.weekId}/players/${player.id}`, { method: 'DELETE' })
      await loadDashboard()
      setNotice(`${player.playerName} was removed from the tournament.`)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusyId('')
    }
  }

  async function generateFixtures() {
    if (!selectedTournament) return
    const hasBracket = bracketMatches.length > 0
    if (hasBracket && !window.confirm('Replace the current unplayed draw with a new random draw?')) return
    setBusyId('fixtures')
    setError('')
    try {
      const data = await request(`/admin/tournaments/${selectedTournament.weekId}/fixtures`, {
        method: 'POST',
      })
      setBracketTournamentId(selectedTournament.weekId)
      setMatches(data.matches)
      setStandings(data.standings)
      setNotice('Random single-elimination fixtures generated.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusyId('')
    }
  }

  function editMatch(match) {
    setMatchDialog(match)
    setMatchDetails({
      status: match.status,
      score1: match.score1 ?? '',
      score2: match.score2 ?? '',
      scheduledAt: localDateTime(match.scheduledAt),
      location: match.location || '',
    })
  }

  async function sendAdminNotification(event) {
    event.preventDefault()
    setBusyId('notification-send')
    setError('')
    setNotice('')
    try {
      const direct = notificationMode === 'direct'
      const data = await request(direct ? '/admin/notifications/direct' : '/admin/notifications', {
        method: 'POST',
        body: JSON.stringify({
          ...(direct ? { playerId: notificationPlayerId } : {}),
          title: notificationForm.title,
          message: notificationForm.description,
        }),
      })
      setNotificationForm({ title: '', description: '' })
      setNotice(direct
        ? `Message delivered to ${data.player.displayName}.`
        : `Announcement delivered to ${data.created} player${data.created === 1 ? '' : 's'}.`)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusyId('')
    }
  }

  async function saveMatch(event) {
    event.preventDefault()
    if (!selectedTournament || !matchDialog) return
    setBusyId(matchDialog.matchId)
    setError('')
    try {
      const data = await request(
        `/admin/tournaments/${selectedTournament.weekId}/matches/${matchDialog.matchId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            status: matchDetails.status,
            score1: matchDetails.score1 === '' ? null : Number(matchDetails.score1),
            score2: matchDetails.score2 === '' ? null : Number(matchDetails.score2),
            scheduledAt: matchDetails.scheduledAt || null,
            location: matchDetails.location,
          }),
        },
      )
      setBracketTournamentId(selectedTournament.weekId)
      setMatches(data.matches)
      setStandings(data.standings)
      setMatchDialog(null)
      setNotice(data.notificationWarning || 'Match result saved. Fixtures and standings are updated.')
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

  const bracketMatches = bracketTournamentId === selectedTournamentId ? matches : []
  const bracketStandings = bracketTournamentId === selectedTournamentId ? standings : []
  const rounds = [...new Set(bracketMatches.map((match) => match.round))].sort((a, b) => a - b)
  const finishedMatches = bracketMatches.filter((match) => match.status === 'finished' && match.player1 && match.player2).length
  const approvedPlayers = selectedRegistrations.filter((registration) => registration.paymentStatus === 'approved').length
  const canGenerate = approvedPlayers >= 2
    && selectedTournament?.status !== 'completed'
    && !bracketMatches.some(
    (match) => match.status === 'ongoing' || (match.status === 'finished' && match.player1 && match.player2),
  )

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <span className="admin-kicker">PRIME GAMING · ORGANIZER CONSOLE</span>
          <h1>Tournament control center</h1>
          <p>Run the competition, manage entries and take every match to the final.</p>
        </div>
        <div className="admin-header-actions">
          <a href="/">Open app</a>
          <ChatBackgroundPicker scope="admin" />
          <button type="button" onClick={signOut}>Sign out</button>
        </div>
      </header>

      <section className="admin-stat-grid" aria-label="Tournament overview">
        <article className="admin-stat-card"><span>TOURNAMENTS</span><strong>{tournaments.length}</strong><small>Running on this platform</small></article>
        <article className="admin-stat-card"><span>REGISTERED PLAYERS</span><strong>{registrations.filter((item) => item.paymentStatus === 'approved').length}</strong><small>Across all tournaments</small></article>
        <article className="admin-stat-card"><span>PAYMENTS TO REVIEW</span><strong>{pendingPayments.length}</strong><small>Entries awaiting approval</small></article>
        <article className="admin-stat-card"><span>COMPLETED MATCHES</span><strong>{finishedMatches}</strong><small>Selected tournament</small></article>
      </section>

      <nav className="admin-tabs" aria-label="Admin sections">
        {[
          ['tournaments', 'Tournaments'],
          ['players', 'Players & roster'],
          ['passes', `Approved passes · ${registrations.filter((item) => item.paymentStatus === 'approved').length}`],
          ['payments', `Entry review${pendingPayments.length ? ` · ${pendingPayments.length}` : ''}`],
          ['bracket', 'Fixtures & standings'],
          ['chats', 'Player chat'],
          ['disputes', 'Match disputes'],
          ['finance', 'Financials'],
          ['notifications', 'Notifications & messages'],
        ].map(([view, label]) => (
          <button type="button" key={view} className={activeView === view ? 'admin-tab admin-tab--active' : 'admin-tab'} onClick={() => setActiveView(view)}>{label}</button>
        ))}
      </nav>

      {error && <p className="admin-error" role="alert">{error}</p>}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      {loading && <p className="admin-loading">Syncing tournament data…</p>}

      {activeView === 'tournaments' && (
        <section className="admin-section">
          <div className="admin-section-heading">
            <div><span className="admin-kicker">COMPETITION OPERATIONS</span><h2>All tournaments</h2><p>Create, schedule and control each competition.</p></div>
            <button className="admin-primary" type="button" onClick={() => {
              setTournamentDetails(tournamentForm(null))
              setTournamentDialog('new')
            }}>＋ Add tournament</button>
          </div>
          {tournaments.length === 0 && !loading && <p className="admin-empty">No tournaments available.</p>}
          <div className="admin-tournament-grid">
            {tournaments.map((tournament) => (
              <article className="admin-tournament-card" key={tournament.weekId}>
                <div className="admin-tournament-card-head">
                  <StatusBadge status={tournament.status} />
                </div>
                <h3>{tournament.name}</h3>
                <p className="admin-tournament-date">{tournament.dateRange}</p>
                <p className="admin-tournament-date">Entry · {Number(tournament.entryFee ?? 1500).toLocaleString()} ETB · Prize pool · {Number(tournament.prizePool ?? 20000).toLocaleString()} ETB</p>
                <div className="admin-capacity"><div><span>SLOTS CLAIMED</span><strong>{tournament.capacity - tournament.availableSlots}<small> / {tournament.capacity}</small></strong></div><div className="admin-capacity-track"><i style={{ width: `${Math.min(100, ((tournament.capacity - tournament.availableSlots) / tournament.capacity) * 100)}%` }} /></div><small>{tournament.availableSlots} open slots · {tournament.playerCount || 0} total entries</small></div>
                <div className="admin-tournament-actions">
                  <button className="admin-secondary" type="button" onClick={() => {
                    setTournamentDetails(tournamentForm(tournament))
                    setTournamentDialog(tournament)
                  }}>Edit</button>
                  <button className="admin-secondary" type="button" onClick={() => {
                    setSelectedTournamentId(tournament.weekId)
                    setActiveView('players')
                  }}>Players</button>
                  <button className="admin-secondary" type="button" onClick={() => {
                    setSelectedTournamentId(tournament.weekId)
                    setActiveView('bracket')
                  }}>Bracket</button>
                  <button className="admin-danger-quiet" type="button" disabled={busyId === `tournament-${tournament.weekId}`} onClick={() => deleteTournament(tournament)}>Delete</button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {activeView === 'notifications' && (
        <section className="admin-section admin-messaging-section">
          <div className="admin-section-heading">
            <div><span className="admin-kicker">PLAYER COMMUNICATIONS</span><h2>Notifications & messages</h2><p>Send competition updates to the community or reach one player directly.</p></div>
          </div>
          <div className="admin-message-layout">
            <div className="admin-message-intro">
              <span className="admin-message-icon">✦</span>
              <span className="admin-kicker">MATCHDAY CONTROL</span>
              <h3>Every player, in the loop.</h3>
              <p>Registration approvals and match outcomes are delivered automatically. Use this console for organizer updates and player support.</p>
              <div><strong>{players.length}</strong><span>registered player accounts</span></div>
            </div>
            <form className="admin-message-form" onSubmit={sendAdminNotification}>
              <div className="admin-message-mode" role="tablist" aria-label="Message audience">
                <button type="button" role="tab" aria-selected={notificationMode === 'broadcast'} className={notificationMode === 'broadcast' ? 'admin-message-mode--active' : ''} onClick={() => setNotificationMode('broadcast')}>Community broadcast</button>
                <button type="button" role="tab" aria-selected={notificationMode === 'direct'} className={notificationMode === 'direct' ? 'admin-message-mode--active' : ''} onClick={() => setNotificationMode('direct')}>Direct message</button>
              </div>
              {notificationMode === 'direct' && (
                <label htmlFor="notification-player">Select player
                  <select id="notification-player" value={notificationPlayerId} onChange={(event) => setNotificationPlayerId(event.target.value)} required>
                    {players.map((player) => <option key={player.id} value={player.id}>{player.displayName} · {player.playerCode || player.contact}</option>)}
                  </select>
                </label>
              )}
              <label htmlFor="notification-title">Notification title
                <input id="notification-title" value={notificationForm.title} maxLength={160} onChange={(event) => setNotificationForm({ ...notificationForm, title: event.target.value })} placeholder={notificationMode === 'direct' ? 'A note for your player' : 'Community announcement'} required />
              </label>
              <label htmlFor="notification-description">{notificationMode === 'direct' ? 'Message description' : 'Announcement description'}
                <textarea id="notification-description" value={notificationForm.description} maxLength={500} rows={5} onChange={(event) => setNotificationForm({ ...notificationForm, description: event.target.value })} placeholder="Write the full announcement or message for players…" required />
                <small>{notificationForm.description.length} / 500 characters</small>
              </label>
              {error && <p className="admin-error" role="alert">{error}</p>}
              <button className="admin-primary" type="submit" disabled={busyId === 'notification-send' || (notificationMode === 'direct' && !players.length)}>
                {busyId === 'notification-send' ? 'Sending…' : notificationMode === 'direct' ? 'Send direct message' : 'Broadcast to players'}
              </button>
            </form>
          </div>
        </section>
      )}

      {activeView === 'chats' && (
        <section className="admin-section">
          <div className="admin-section-heading"><div><span className="admin-kicker">TWO-WAY PLAYER SUPPORT</span><h2>Live player chat</h2><p>Read incoming messages and reply directly to registered players.</p></div></div>
          <AdminChatManager onError={setError} />
        </section>
      )}

      {activeView === 'disputes' && (
        <section className="admin-section">
          <AdminDisputesPanel onError={setError} onNotice={setNotice} />
        </section>
      )}

      {activeView === 'finance' && (
        <section className="admin-section">
          <AdminFinancePanel onError={setError} />
        </section>
      )}

      {activeView !== 'tournaments' && activeView !== 'notifications'
        && activeView !== 'chats' && activeView !== 'disputes' && activeView !== 'finance' && (
        <section className="admin-section">
          <div className="admin-section-heading">
            <div><span className="admin-kicker">{activeView === 'players' ? 'APPROVED PLAYER ROSTER' : activeView === 'passes' ? 'PAYMENT APPROVED · DIGITAL PASS ISSUED' : activeView === 'payments' ? 'REGISTRATION INBOX' : 'SINGLE-ELIMINATION CONTROL'}</span>
              <h2>{activeView === 'players' ? 'Players & roster' : activeView === 'passes' ? 'Approved passes & check-in' : activeView === 'payments' ? 'Entry review' : 'Fixtures & standings'}</h2>
              <p>{activeView === 'passes'
                ? 'Approved players, pass issuance, match assignments and venue check-in status.'
                : selectedTournament ? `${selectedTournament.name} · ${selectedTournament.dateRange}` : 'Choose a tournament to continue.'}</p>
            </div>
            <div className="admin-view-controls">
              <select aria-label="Select tournament" value={selectedTournamentId ?? ''} onChange={(event) => setSelectedTournamentId(Number(event.target.value))}>
                {tournaments.map((tournament) => <option key={tournament.weekId} value={tournament.weekId}>{tournament.name}</option>)}
              </select>
              {activeView === 'players' && selectedTournament && (
                <>
                  <button className="admin-secondary" type="button" onClick={() => downloadRosterCsv(roster, selectedTournament)}>Export CSV</button>
                  <button className="admin-primary" type="button" disabled={!selectedTournament.availableSlots || selectedTournament.status !== 'upcoming'} onClick={() => setPlayerDialog(true)}>＋ Add player</button>
                </>
              )}
              {activeView === 'passes' && <button className="admin-secondary" type="button" onClick={loadDashboard}>Refresh pass list</button>}
              {activeView === 'bracket' && selectedTournament && (
                <button className="admin-primary" type="button" disabled={!canGenerate || busyId === 'fixtures'} onClick={generateFixtures}>
                  {busyId === 'fixtures' ? 'Drawing…' : bracketMatches.length ? '↻ Redraw fixtures' : '✦ Generate fixtures'}
                </button>
              )}
            </div>
          </div>

          {activeView === 'players' && (
            <div className="admin-roster-panel">
              <div className="admin-roster-summary"><strong>{approvedPlayers}<small> / {selectedTournament?.capacity || 0}</small></strong><span>approved players</span><div className="admin-capacity-track"><i style={{ width: `${selectedTournament ? Math.min(100, approvedPlayers / selectedTournament.capacity * 100) : 0}%` }} /></div></div>
              <div className="admin-player-table-wrap">
                <table className="admin-player-table">
                  <thead><tr><th>PLAYER</th><th>PLAYER CODE</th><th>CONTACT</th><th>TELEGRAM</th><th>ENTRY</th><th>STATUS</th><th /></tr></thead>
                  <tbody>
                    {selectedRegistrations.filter((item) => item.paymentStatus === 'approved').map((player) => (
                      <tr key={player.id}><td><strong>{player.playerName}</strong><small>{player.confirmationCode}</small></td><td><strong>{player.playerCode || '—'}</strong></td><td>{player.contact}</td><td>{player.telegramUsername ? `@${player.telegramUsername.replace(/^@/, '')}` : '—'}</td><td>{player.payment}</td><td><StatusBadge status="approved" /></td><td><button className="admin-danger-quiet" type="button" disabled={busyId === player.id} onClick={() => removePlayer(player)}>Remove</button></td></tr>
                    ))}
                  </tbody>
                </table>
                {approvedPlayers === 0 && <p className="admin-empty">No approved players yet. Review entries or add a player manually.</p>}
              </div>
            </div>
          )}

          {activeView === 'passes' && (
            <div className="admin-player-table-wrap">
              <table className="admin-player-table">
                <thead><tr><th>PLAYER / CODE</th><th>CONTACT</th><th>TELEGRAM</th><th>MATCH / OPPONENT</th><th>TIME / LOCATION</th><th>PASS / CHECK-IN</th><th>STAGE</th></tr></thead>
                <tbody>
                  {selectedRegistrations.filter((player) => player.paymentStatus === 'approved').map((player) => {
                    const assignedMatch = bracketMatches.find((match) => (
                      String(match.player1Id || '') === String(player.id)
                      || String(match.player2Id || '') === String(player.id)
                    ))
                    const opponent = assignedMatch
                      ? String(assignedMatch.player1Id) === String(player.id) ? assignedMatch.player2 : assignedMatch.player1
                      : null
                    return (
                      <tr key={player.id}>
                        <td><strong>{player.playerName}</strong><small>{player.playerCode || player.confirmationCode}</small></td>
                        <td>{player.contact}</td>
                        <td>{player.telegramUsername ? `@${player.telegramUsername.replace(/^@/, '')}` : '—'}</td>
                        <td><strong>{assignedMatch?.roundName || 'Not scheduled'}</strong>{opponent?.playerName && <small>vs {opponent.playerName}</small>}</td>
                        <td>{assignedMatch?.scheduledAt ? new Date(assignedMatch.scheduledAt).toLocaleString('en-ET', { timeZone: 'Africa/Addis_Ababa' }) : 'Not scheduled'}{assignedMatch?.location && <small>{assignedMatch.location}</small>}</td>
                        <td><strong>{player.hasPass ? 'Pass issued' : 'No pass'}</strong><small>{player.checkInStatus === 'checked_in' ? 'Checked in' : 'Not checked in'} · {player.readyStatus === 'ready' ? 'Ready' : 'Not ready'}</small></td>
                        <td>{(player.passStage || 'not_started').replaceAll('_', ' ')}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {!selectedRegistrations.some((player) => player.paymentStatus === 'approved') && <p className="admin-empty">No approved passes in this tournament yet.</p>}
            </div>
          )}

          {activeView === 'payments' && (
            <>
              <form className="admin-payment-accounts" onSubmit={savePaymentAccounts}>
                <div className="admin-section-heading"><div><span className="admin-kicker">CHECKOUT DETAILS</span><h2>Payment accounts</h2><p>These details are shown to players during registration.</p></div></div>
                <div className="admin-payment-account-grid">
                  {paymentAccounts.map((account) => (
                    <div className="admin-payment-account" key={account.type}>
                      <strong>{account.type === 'cbe' ? 'CBE Bank' : 'Telebirr'}</strong>
                      <label>Account holder<input value={account.name} maxLength={120} onChange={(event) => setPaymentAccounts((current) => current.map((item) => item.type === account.type ? { ...item, name: event.target.value } : item))} /></label>
                      <label>Account number / phone<input value={account.number} maxLength={80} onChange={(event) => setPaymentAccounts((current) => current.map((item) => item.type === account.type ? { ...item, number: event.target.value } : item))} /></label>
                    </div>
                  ))}
                </div>
                <button className="admin-primary" type="submit" disabled={busyId === 'payment-accounts'}>{busyId === 'payment-accounts' ? 'Saving…' : 'Save payment accounts'}</button>
              </form>
              <div className="admin-registration-list">
                {paymentGroups.filter((group) => group.weekId === selectedTournamentId).map((group) => (
                  <article className="admin-registration-card" key={group.id}>
                    <div className="admin-registration-heading"><div><h3>{group.members.length === 1 ? group.members[0].playerName : `${group.members.length} player group`}</h3><span>{group.paymentGroupId ? `Checkout ${group.paymentGroupId.slice(0, 8)}` : group.members[0]?.confirmationCode}</span></div><StatusBadge status="pending" /></div>
                    <dl><div><dt>Payment</dt><dd>{group.payment}</dd></div><div><dt>Players</dt><dd>{group.members.length}</dd></div><div><dt>Total due</dt><dd>{(group.members.length * Number(selectedTournament?.entryFee || 0)).toLocaleString()} ETB</dd></div><div><dt>Submitted</dt><dd>{group.createdAt ? new Date(group.createdAt).toLocaleString() : '—'}</dd></div></dl>
                    <ul className="admin-payment-members">{group.members.map((member) => <li key={member.id}><strong>{member.playerName}</strong><span>{member.telegramUsername ? `@${member.telegramUsername.replace(/^@/, '')}` : 'No Telegram username'} · {member.sessionPreference || 'any session'} · {member.confirmationCode}</span></li>)}</ul>
                    {group.receiptData ? <a className="admin-receipt" href={group.receiptData} target="_blank" rel="noreferrer">View payment receipt <img src={group.receiptData} alt="Uploaded payment receipt" /></a> : <span className="admin-no-receipt">No receipt uploaded</span>}
                    <label className="admin-rejection-reason">Rejection reason (required to reject)
                      <textarea value={rejectionReasons[group.id] || ''} maxLength={1000} rows={2} onChange={(event) => setRejectionReasons((current) => ({ ...current, [group.id]: event.target.value }))} placeholder="Explain what needs to be corrected…" />
                    </label>
                    <div className="admin-actions">
                      <button className="admin-approve" type="button" disabled={busyId === group.id} onClick={() => reviewPaymentGroup(group, 'approved')}>Approve payment & issue passes</button>
                      <button className="admin-reject" type="button" disabled={busyId === group.id || !(rejectionReasons[group.id] || '').trim()} onClick={() => reviewPaymentGroup(group, 'rejected')}>Reject payment</button>
                    </div>
                  </article>
                ))}
                {!paymentGroups.some((group) => group.weekId === selectedTournamentId) && <p className="admin-empty">No pending payments for this tournament.</p>}
              </div>
            </>
          )}

          {activeView === 'bracket' && (
            <div className="admin-bracket-layout">
              <div className="admin-bracket-main">
                <div className="admin-bracket-summary">
                  <div><span>APPROVED PLAYERS</span><strong>{approvedPlayers}</strong></div>
                  <div><span>PLAYED MATCHES</span><strong>{finishedMatches}</strong></div>
                  <div><span>{selectedTournament?.format === 'league' ? 'LEAGUE ROUNDS' : 'BRACKET ROUNDS'}</span><strong>{rounds.length}</strong></div>
                </div>
                {bracketMatches.length === 0
                  ? <div className="admin-empty-state"><span>✦</span><h3>Your {selectedTournament?.format === 'league' ? 'league schedule' : 'bracket'} starts here</h3><p>Approve at least two players, then generate {selectedTournament?.format === 'league' ? 'a round-robin league schedule' : 'a randomized single-elimination draw'}.</p><button className="admin-primary" type="button" disabled={!canGenerate} onClick={generateFixtures}>Generate fixtures</button></div>
                  : <div className="admin-rounds">
                    {rounds.map((round) => {
                      const roundMatches = bracketMatches.filter((match) => match.round === round)
                      return <section className="admin-round-column" key={round}><div className="admin-round-heading"><span>ROUND {round + 1}</span><h3>{roundMatches[0]?.roundName}</h3></div>{roundMatches.map((match) => <MatchCard match={match} key={match.matchId} onSelect={editMatch} />)}</section>
                    })}
                  </div>}
              </div>
              <aside className="admin-standings-panel">
                <span className="admin-kicker">LIVE LEADERBOARD</span><h3>Standings</h3>
                {bracketStandings.length === 0
                  ? <p className="admin-empty">Standings appear as match results are recorded.</p>
                  : bracketStandings.map((standing) => (
                    <article className="admin-standing-row" key={standing.player.id}>
                      <strong>{String(standing.rank).padStart(2, '0')}</strong>
                      <span><b>{standing.player.playerName}</b><small>{selectedTournament?.format === 'league' ? `${standing.points} pts · ` : ''}{standing.wins}W · {standing.losses}L · {standing.goalsFor}:{standing.goalsAgainst}</small></span>
                      {standing.champion && <i>CHAMPION</i>}
                    </article>
                  ))}
              </aside>
            </div>
          )}
        </section>
      )}

      {tournamentDialog && (
        createPortal(<div className="admin-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setTournamentDialog(null)}>
          <form className="admin-modal" role="dialog" aria-modal="true" onSubmit={saveTournament} aria-labelledby="tournament-dialog-title">
            <button className="admin-modal-close" type="button" aria-label="Close" onClick={() => setTournamentDialog(null)}>×</button>
            <span className="admin-kicker">{tournamentDialog === 'new' ? 'NEW COMPETITION' : 'TOURNAMENT SETTINGS'}</span>
            <h2 id="tournament-dialog-title">{tournamentDialog === 'new' ? 'Create tournament' : 'Edit tournament'}</h2>
            <label htmlFor="tournament-date">Date or date range</label><input id="tournament-date" value={tournamentDetails.dateRange} maxLength={40} placeholder="Nov 1 - Nov 7" onChange={(event) => setTournamentDetails({ ...tournamentDetails, dateRange: event.target.value })} required />
            <div className="admin-modal-row"><div><label htmlFor="tournament-capacity">Player capacity</label><input id="tournament-capacity" type="number" min="2" max="128" value={tournamentDetails.capacity} onChange={(event) => setTournamentDetails({ ...tournamentDetails, capacity: event.target.value })} required /></div><div><label htmlFor="tournament-status">Status</label><select id="tournament-status" value={tournamentDetails.status} onChange={(event) => setTournamentDetails({ ...tournamentDetails, status: event.target.value })}><option value="upcoming">Upcoming</option><option value="live">Live</option><option value="completed">Completed</option></select></div></div>
            <div className="admin-modal-row"><div><label htmlFor="tournament-type">Tournament type</label><select id="tournament-type" value={tournamentDetails.type} onChange={(event) => setTournamentDetails({ ...tournamentDetails, type: event.target.value })}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></div><div><label htmlFor="tournament-format">Match format</label><select id="tournament-format" value={tournamentDetails.format} onChange={(event) => setTournamentDetails({ ...tournamentDetails, format: event.target.value })}><option value="knockout">Knockout</option><option value="league">League</option></select></div></div>
            <label htmlFor="tournament-fee">Entry fee (ETB)</label><input id="tournament-fee" type="number" min="0" max="1000000" value={tournamentDetails.entryFee} onChange={(event) => setTournamentDetails({ ...tournamentDetails, entryFee: event.target.value })} required />
            <fieldset className="admin-prize-tiers"><legend>Prize distribution</legend><p>Total cash awards: {tournamentDetails.prizeTiers.reduce((sum, tier) => sum + Number(tier.amount || 0), 0).toLocaleString()} ETB</p>
              {tournamentDetails.prizeTiers.map((tier, index) => <div className="admin-prize-tier" key={tier.rank}>
                <strong>Place {tier.rank}</strong>
                <div className="admin-modal-row"><div><label htmlFor={`prize-amount-${tier.rank}`}>Cash amount (ETB)</label><input id={`prize-amount-${tier.rank}`} type="number" min="0" max="10000000" value={tier.amount} onChange={(event) => setTournamentDetails((current) => ({ ...current, prizeTiers: current.prizeTiers.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item) }))} required /></div><div><label htmlFor={`prize-reward-${tier.rank}`}>Additional reward</label><input id={`prize-reward-${tier.rank}`} maxLength={120} value={tier.reward} onChange={(event) => setTournamentDetails((current) => ({ ...current, prizeTiers: current.prizeTiers.map((item, itemIndex) => itemIndex === index ? { ...item, reward: event.target.value } : item) }))} placeholder="Optional reward" /></div></div>
                {index > 0 && <button className="admin-secondary" type="button" onClick={() => setTournamentDetails((current) => ({ ...current, prizeTiers: current.prizeTiers.filter((_, itemIndex) => itemIndex !== index).map((item, itemIndex) => ({ ...item, rank: itemIndex + 1 })) }))}>Remove place</button>}
              </div>)}
              {tournamentDetails.prizeTiers.length < 128 && <button className="admin-secondary" type="button" onClick={() => setTournamentDetails((current) => ({ ...current, prizeTiers: [...current.prizeTiers, { rank: current.prizeTiers.length + 1, amount: '0', reward: '' }] }))}>Add prize place</button>}
            </fieldset>
            {error && <p className="admin-error" role="alert">{error}</p>}
            <div className="admin-modal-actions"><button className="admin-secondary" type="button" onClick={() => setTournamentDialog(null)}>Cancel</button><button className="admin-primary" type="submit" disabled={busyId === 'tournament-save'}>{busyId === 'tournament-save' ? 'Saving…' : 'Save tournament'}</button></div>
          </form>
        </div>, document.body)
      )}

      {playerDialog && selectedTournament && (
        createPortal(<div className="admin-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setPlayerDialog(false)}>
          <form className="admin-modal" role="dialog" aria-modal="true" onSubmit={addPlayer} aria-labelledby="player-dialog-title">
            <button className="admin-modal-close" type="button" aria-label="Close" onClick={() => setPlayerDialog(false)}>×</button>
            <span className="admin-kicker">MANUAL ROSTER ENTRY</span><h2 id="player-dialog-title">Add a player</h2>
            <p>This player joins the approved roster directly. Adding them replaces any draw that has not started.</p>
            <label htmlFor="player-name">Player name</label><input id="player-name" maxLength={60} value={playerDetails.playerName} onChange={(event) => setPlayerDetails({ ...playerDetails, playerName: event.target.value })} required />
            <label htmlFor="player-contact">Phone or contact</label><input id="player-contact" maxLength={64} value={playerDetails.contact} onChange={(event) => setPlayerDetails({ ...playerDetails, contact: event.target.value })} required />
            <label htmlFor="player-telegram">Telegram username <span>Optional</span></label><input id="player-telegram" maxLength={33} value={playerDetails.telegramUsername} onChange={(event) => setPlayerDetails({ ...playerDetails, telegramUsername: event.target.value })} placeholder="@username" pattern="@?[A-Za-z0-9_]{5,32}" />
            {error && <p className="admin-error" role="alert">{error}</p>}
            <div className="admin-modal-actions"><button className="admin-secondary" type="button" onClick={() => setPlayerDialog(false)}>Cancel</button><button className="admin-primary" type="submit" disabled={busyId === 'player-add'}>{busyId === 'player-add' ? 'Adding…' : 'Add player'}</button></div>
          </form>
        </div>, document.body)
      )}

      {matchDialog && (
        createPortal(<div className="admin-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setMatchDialog(null)}>
          <form className="admin-modal" role="dialog" aria-modal="true" onSubmit={saveMatch} aria-labelledby="match-dialog-title">
            <button className="admin-modal-close" type="button" aria-label="Close" onClick={() => setMatchDialog(null)}>×</button>
            <span className="admin-kicker">{matchDialog.roundName} · MATCH {matchDialog.matchNumber}</span><h2 id="match-dialog-title">Update match</h2>
            <div className="admin-score-row"><label>{matchDialog.player1?.playerName || 'Player 1'}<input type="number" min="0" max="99" value={matchDetails.score1} onChange={(event) => setMatchDetails({ ...matchDetails, score1: event.target.value })} /></label><span>VS</span><label>{matchDialog.player2?.playerName || 'Player 2'}<input type="number" min="0" max="99" value={matchDetails.score2} onChange={(event) => setMatchDetails({ ...matchDetails, score2: event.target.value })} /></label></div>
            <label htmlFor="match-scheduled-at">Kickoff time <span>Players receive an alert when this changes</span></label><input id="match-scheduled-at" type="datetime-local" value={matchDetails.scheduledAt} onChange={(event) => setMatchDetails({ ...matchDetails, scheduledAt: event.target.value })} />
            <label htmlFor="match-location">Match location <span>Optional · included in match-day reminders</span></label><input id="match-location" maxLength={120} value={matchDetails.location} onChange={(event) => setMatchDetails({ ...matchDetails, location: event.target.value })} placeholder="Tournament venue or online lobby" />
            <label htmlFor="match-status">Match status</label><select id="match-status" value={matchDetails.status} onChange={(event) => setMatchDetails({ ...matchDetails, status: event.target.value })}><option value="pending">Pending</option><option value="ongoing">Ongoing</option><option value="finished">Finished</option></select>
            <p>Set a decisive score to finish a match. The winner advances automatically.</p>
            {error && <p className="admin-error" role="alert">{error}</p>}
            <div className="admin-modal-actions"><button className="admin-secondary" type="button" onClick={() => setMatchDialog(null)}>Cancel</button><button className="admin-primary" type="submit" disabled={busyId === matchDialog.matchId}>{busyId === matchDialog.matchId ? 'Saving…' : 'Save match'}</button></div>
          </form>
        </div>, document.body)
      )}
    </main>
  )
}
