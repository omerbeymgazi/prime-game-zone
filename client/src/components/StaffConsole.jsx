import { useCallback, useEffect, useRef, useState } from 'react'
import './StaffConsole.css'
import { apiRequest } from '../api.js'

async function request(path, options = {}) {
  return apiRequest(`/api${path}`, options)
}

function localDateTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export default function StaffConsole() {
  const [authenticated, setAuthenticated] = useState(false)
  const [checkingSession, setCheckingSession] = useState(true)
  const [credentials, setCredentials] = useState({ username: '', password: '' })
  const [date, setDate] = useState(() => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Addis_Ababa',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date()))
  const [fixtures, setFixtures] = useState([])
  const [approvedPasses, setApprovedPasses] = useState([])
  const [chats, setChats] = useState([])
  const [selectedPlayerId, setSelectedPlayerId] = useState('')
  const [messages, setMessages] = useState([])
  const [reply, setReply] = useState('')
  const [passToken, setPassToken] = useState('')
  const [activePassPlayer, setActivePassPlayer] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [passAlert, setPassAlert] = useState(null)
  const [busy, setBusy] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const timerRef = useRef(null)
  const scanBusyRef = useRef(false)

  const loadFixtures = useCallback(async () => {
    try {
      const data = await request(`/staff/fixtures?date=${encodeURIComponent(date)}`)
      setFixtures(data.fixtures || [])
    } catch (requestError) {
      setError(requestError.message)
    }
  }, [date])

  const loadApprovedPasses = useCallback(async () => {
    try {
      const data = await request('/staff/approved-passes')
      setApprovedPasses(data.passes || [])
    } catch (requestError) {
      setError(requestError.message)
    }
  }, [])

  const loadChats = useCallback(async () => {
    try {
      const data = await request('/staff/chats')
      setChats(data.chats || [])
      setSelectedPlayerId((current) => current || data.chats?.[0]?.playerId || '')
    } catch (requestError) {
      setError(requestError.message)
    }
  }, [])

  const loadMessages = useCallback(async () => {
    if (!selectedPlayerId) {
      setMessages([])
      return
    }
    try {
      const data = await request(`/staff/chats/${encodeURIComponent(selectedPlayerId)}`)
      setMessages(data.messages || [])
    } catch (requestError) {
      setError(requestError.message)
    }
  }, [selectedPlayerId])

  useEffect(() => {
    request('/staff/session')
      .then((data) => setAuthenticated(data.authenticated === true))
      .catch((requestError) => {
        setError(requestError.message)
      })
      .finally(() => setCheckingSession(false))
  }, [])

  useEffect(() => {
    if (!authenticated) return undefined
    loadFixtures()
    loadApprovedPasses()
    loadChats()
    const timer = window.setInterval(() => {
      loadFixtures()
      loadApprovedPasses()
      loadChats()
    }, 15000)
    return () => window.clearInterval(timer)
  }, [authenticated, loadApprovedPasses, loadChats, loadFixtures])

  useEffect(() => {
    if (authenticated) loadMessages()
  }, [authenticated, loadMessages])

  useEffect(() => () => {
    if (timerRef.current) window.clearInterval(timerRef.current)
    streamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  async function signIn(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await request('/staff/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      })
      const session = await request('/staff/session')
      if (!session.authenticated) throw new Error('Staff sign-in could not be verified. Please try again.')
      setAuthenticated(true)
      setCredentials({ username: '', password: '' })
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
      setCheckingSession(false)
    }
  }

  async function signOut() {
    try {
      await request('/staff/session', { method: 'DELETE' })
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setAuthenticated(false)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      setStreaming(false)
    }
  }

  async function checkIn(event) {
    event?.preventDefault()
    await checkInValue(passToken)
  }

  async function startScanner() {
    setError('')
    if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
      setError('Camera QR scanning is not supported here. Enter the pass code manually below.')
      return
    }
    try {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      streamRef.current = stream
      if (!videoRef.current) return
      videoRef.current.srcObject = stream
      await videoRef.current.play()
      setStreaming(true)
      timerRef.current = window.setInterval(async () => {
        if (!videoRef.current || scanBusyRef.current) return
        scanBusyRef.current = true
        try {
          const codes = await detector.detect(videoRef.current)
          const value = codes[0]?.rawValue
          if (value) {
            setPassToken(value)
            window.clearInterval(timerRef.current)
            streamRef.current?.getTracks().forEach((track) => track.stop())
            setStreaming(false)
            scanBusyRef.current = false
            await checkInValue(value)
            return
          }
        } catch (scanError) {
          setError(`QR scan failed: ${scanError.message}`)
          window.clearInterval(timerRef.current)
        } finally {
          scanBusyRef.current = false
        }
      }, 500)
    } catch (requestError) {
      setError(requestError.message || 'Camera access was denied.')
    }
  }

  async function checkInValue(value) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const data = await request('/staff/check-in', {
        method: 'POST',
        body: JSON.stringify({ passToken: value }),
      })
      setActivePassPlayer(data.player)
      setNotice(`${data.player.playerName} checked in. Continue with the next pass stage below.`)
      setPassAlert({
        type: 'success',
        title: 'Check-in complete',
        message: `${data.player.playerName} is checked in for ${data.player.tournamentName || 'the tournament'}.`,
      })
      setPassToken('')
      await loadApprovedPasses()
    } catch (requestError) {
      setError(requestError.message)
      setPassAlert({
        type: 'error',
        title: 'Pass not accepted',
        message: requestError.message,
      })
    } finally {
      setBusy(false)
    }
  }

  async function advancePassStage(stage) {
    if (!activePassPlayer?.id) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const data = await request(`/staff/registrations/${encodeURIComponent(activePassPlayer.id)}/stage`, {
        method: 'PATCH',
        body: JSON.stringify({ stage }),
      })
      setActivePassPlayer(data.player)
      setNotice(`${data.player.playerName} advanced to ${stage.replaceAll('_', ' ')}.`)
      await loadApprovedPasses()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function updateSchedule(event, fixture) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError('')
    try {
      await request(`/staff/tournaments/${fixture.weekId}/matches/${encodeURIComponent(fixture.matchId)}/schedule`, {
        method: 'PATCH',
        body: JSON.stringify({
          scheduledAt: form.get('scheduledAt') ? new Date(form.get('scheduledAt')).toISOString() : null,
          location: String(form.get('location') || ''),
        }),
      })
      setNotice('Fixture time and venue updated. Players were notified.')
      await loadFixtures()
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  async function sendReply(event) {
    event.preventDefault()
    if (!selectedPlayerId || !reply.trim()) return
    setBusy(true)
    setError('')
    try {
      await request(`/staff/chats/${encodeURIComponent(selectedPlayerId)}`, {
        method: 'POST',
        body: JSON.stringify({ body: reply.trim() }),
      })
      setReply('')
      await loadMessages()
      setNotice('Message sent to player.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  if (checkingSession) return <main className="staff-shell"><p className="staff-muted">Checking staff session…</p></main>

  if (!authenticated) return (
    <main className="staff-shell staff-login-shell">
      <form className="staff-login-card" onSubmit={signIn}>
        <span className="staff-kicker">PRIME GAMING ZONE · VENUE OPERATIONS</span>
        <h1>Staff Console</h1>
        <p>Sign in to manage match-day fixtures, player check-in, and communications.</p>
        <label>Staff username<input autoComplete="username" value={credentials.username} onChange={(event) => setCredentials({ ...credentials, username: event.target.value })} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={credentials.password} onChange={(event) => setCredentials({ ...credentials, password: event.target.value })} required /></label>
        {error && <p className="staff-error" role="alert">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in to staff console'}</button>
        <a href="/">Return to player app</a>
      </form>
    </main>
  )

  return (
    <main className="staff-shell">
      <header className="staff-header">
        <div><span className="staff-kicker">PRIME GAMING ZONE · VENUE OPERATIONS</span><h1>Staff Console</h1><p>Match-day tools only · no financial or super-admin access</p></div>
        <div><a href="/">Player app</a><button type="button" onClick={signOut}>Sign out</button></div>
      </header>
      {error && <p className="staff-error" role="alert">{error}</p>}
      {notice && <p className="staff-notice" role="status">{notice}</p>}
      {passAlert && <div className="staff-pass-alert-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setPassAlert(null)
      }}>
        <section className={`staff-pass-alert staff-pass-alert--${passAlert.type}`} role="alertdialog" aria-modal="true" aria-labelledby="staff-pass-alert-title">
          <span className="staff-pass-alert-icon">{passAlert.type === 'success' ? '✓' : '!'}</span>
          <h2 id="staff-pass-alert-title">{passAlert.title}</h2>
          <p>{passAlert.message}</p>
          <button type="button" onClick={() => setPassAlert(null)}>Got it</button>
        </section>
      </div>}
      <section className="staff-panel staff-checkin">
        <div><span className="staff-kicker">VENUE ENTRY</span><h2>Player check-in</h2><p>Scan an approved player's digital pass or enter the QR code value.</p></div>
        <button type="button" onClick={streaming ? () => {
          window.clearInterval(timerRef.current)
          streamRef.current?.getTracks().forEach((track) => track.stop())
          setStreaming(false)
        } : startScanner}>{streaming ? 'Stop scanner' : 'Open QR scanner'}</button>
        {streaming && <video ref={videoRef} className="staff-camera" playsInline muted />}
        <form className="staff-checkin-form" onSubmit={checkIn}>
          <input aria-label="Digital pass code" value={passToken} onChange={(event) => setPassToken(event.target.value)} placeholder="Scan or paste PGZ-PASS code" required />
          <button type="submit" disabled={busy || !passToken.trim()}>{busy ? 'Checking…' : 'Check in player'}</button>
        </form>
        <div className="staff-pass-stages" aria-label="Digital pass activation stages">
          {[
            { id: 'check_in', label: '1 · Check in' },
            { id: 'play_off', label: '2 · Play-off' },
            { id: 'end_of_play', label: '3 · End of play' },
          ].map((step) => {
            const stageOrder = ['not_started', 'check_in', 'play_off', 'end_of_play']
            const currentOrder = stageOrder.indexOf(activePassPlayer?.passStage || 'not_started')
            const stepOrder = stageOrder.indexOf(step.id)
            const completed = currentOrder >= stepOrder && currentOrder > 0
            const actionable = step.id === 'play_off' || step.id === 'end_of_play'
            const canAdvance = activePassPlayer && stepOrder === currentOrder + 1 && actionable
            return (
              <button
                type="button"
                key={step.id}
                className={`staff-pass-stage${completed ? ' staff-pass-stage--complete' : ''}`}
                disabled={busy || !canAdvance}
                onClick={() => canAdvance && advancePassStage(step.id)}
                aria-current={activePassPlayer?.passStage === step.id ? 'step' : undefined}
              >
                <span>{completed ? '✓' : step.id === activePassPlayer?.passStage ? '●' : '○'}</span>
                {step.label}
              </button>
            )
          })}
        </div>
        {activePassPlayer && <p className="staff-pass-player" role="status">
          Active pass: <strong>{activePassPlayer.playerName}</strong> · {activePassPlayer.passStage.replaceAll('_', ' ')}
        </p>}
      </section>

      <section className="staff-panel">
        <div className="staff-panel-heading">
          <div><span className="staff-kicker">PAYMENT APPROVED · DIGITAL PASS ISSUED</span><h2>Approved players &amp; passes</h2><p>Pass and check-in status refresh automatically every 15 seconds.</p></div>
          <button type="button" onClick={loadApprovedPasses}>Refresh passes</button>
        </div>
        {approvedPasses.length
          ? <div className="staff-pass-table-wrap"><table className="staff-pass-table">
            <thead><tr><th>PLAYER / CODE</th><th>CONTACT</th><th>TOURNAMENT</th><th>MATCH TIME / VENUE</th><th>PASS STATUS</th></tr></thead>
            <tbody>{approvedPasses.map((player) => (
              <tr key={player.id}>
                <td><strong>{player.playerName}</strong><small>{player.playerCode || player.confirmationCode}</small>{player.telegramUsername && <small>Telegram · @{player.telegramUsername.replace(/^@/, '')}</small>}</td>
                <td>{player.contact}</td>
                <td><strong>{player.tournamentName}</strong>{player.opponentName && <small>vs {player.opponentName}</small>}</td>
                <td>{player.scheduledAt ? new Date(player.scheduledAt).toLocaleString('en-ET', { timeZone: 'Africa/Addis_Ababa' }) : 'Not scheduled'}{player.location && <small>{player.location}</small>}</td>
                <td><strong>{player.hasPass ? 'Pass issued' : 'Pass unavailable'}</strong><small>{player.checkInStatus === 'checked_in' ? 'Checked in' : 'Not checked in'} · {player.passStage.replaceAll('_', ' ')}</small><small>{player.readyStatus === 'ready' ? 'Ready' : 'Not ready'}</small></td>
              </tr>
            ))}</tbody>
          </table></div>
          : <p className="staff-muted">No approved player passes are available yet.</p>}
      </section>

      <section className="staff-panel">
        <div className="staff-panel-heading"><div><span className="staff-kicker">MATCH-DAY OPERATIONS</span><h2>Daily fixtures</h2></div><label>Fixture date<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label></div>
        {fixtures.length
          ? <div className="staff-fixture-grid">{fixtures.map((fixture) => (
            <article className="staff-fixture-card" key={`${fixture.weekId}-${fixture.matchId}`}>
              <div className="staff-fixture-title"><span>{fixture.tournamentName}</span><strong>{fixture.roundName} · Match {fixture.matchNumber}</strong></div>
              <div className="staff-versus"><span>{fixture.player1?.playerName || 'TBD'}</span><b>VS</b><span>{fixture.player2?.playerName || 'TBD'}</span></div>
              <form onSubmit={(event) => updateSchedule(event, fixture)}>
                <label>Kickoff<input name="scheduledAt" type="datetime-local" defaultValue={localDateTime(fixture.scheduledAt)} /></label>
                <label>Venue / lobby<input name="location" maxLength={120} defaultValue={fixture.location || ''} placeholder="Venue or online lobby" /></label>
                <button type="submit" disabled={busy}>Save schedule</button>
              </form>
            </article>
          ))}</div>
          : <p className="staff-muted">No scheduled matches for this date.</p>}
      </section>

      <section className="staff-panel">
        <div className="staff-panel-heading"><div><span className="staff-kicker">PLAYER SUPPORT</span><h2>Messages</h2></div><button type="button" onClick={loadChats}>Refresh inbox</button></div>
        <div className="staff-chat-layout">
          <nav className="staff-chat-list" aria-label="Player conversations">
            {chats.map((chat) => <button type="button" key={chat.playerId} className={selectedPlayerId === chat.playerId ? 'staff-chat-active' : ''} onClick={() => setSelectedPlayerId(chat.playerId)}>
              <strong>{chat.displayName}</strong><span>{chat.latestMessage || 'No messages yet'}</span>{chat.unreadCount > 0 && <i>{chat.unreadCount}</i>}
            </button>)}
            {!chats.length && <p className="staff-muted">No player conversations yet.</p>}
          </nav>
          <div className="staff-chat-thread">
            <div className="staff-message-list">{messages.map((message) => <article className={`staff-message staff-message--${message.sender}`} key={message.id}><p>{message.deletedAt ? 'Message deleted' : message.body}</p><time>{new Date(message.createdAt).toLocaleString()}</time></article>)}</div>
            <form onSubmit={sendReply}><input value={reply} onChange={(event) => setReply(event.target.value)} maxLength={2000} placeholder={selectedPlayerId ? 'Write a player reply…' : 'Select a conversation'} disabled={!selectedPlayerId} required /><button type="submit" disabled={busy || !selectedPlayerId || !reply.trim()}>Send reply</button></form>
          </div>
        </div>
      </section>
    </main>
  )
}
