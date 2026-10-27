import { useEffect, useState } from 'react'
import './PlayerDisputeForm.css'
import { apiRequest } from '../api.js'

const API_BASE = '/api'

async function request(path, options = {}) {
  return apiRequest(`${API_BASE}${path}`, options)
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read proof image.'))
    reader.onerror = () => reject(new Error('Could not read proof image.'))
    reader.readAsDataURL(file)
  })
}

export default function PlayerDisputeForm({ activeRegistration }) {
  const [matches, setMatches] = useState([])
  const [disputes, setDisputes] = useState([])
  const [matchId, setMatchId] = useState('')
  const [details, setDetails] = useState('')
  const [proof, setProof] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!activeRegistration || activeRegistration.paymentStatus !== 'approved') return
    let active = true
    Promise.all([
      request(`/tournaments/${activeRegistration.weekId}/fixtures`),
      request('/player/disputes'),
    ]).then(([fixtureData, disputeData]) => {
      if (!active) return
      const playerMatches = (fixtureData.matches || []).filter((match) => (
        match.status !== 'bye'
        && [match.player1?.id, match.player2?.id].some((id) => String(id) === String(activeRegistration.id))
      ))
      setMatches(playerMatches)
      setDisputes(disputeData.disputes || [])
      setMatchId((current) => current || playerMatches[0]?.matchId || '')
    }).catch((requestError) => {
      if (active) setError(requestError.message)
    })
    return () => { active = false }
  }, [activeRegistration])

  async function chooseProof(event) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError('Choose a PNG, JPG or WebP image smaller than 5 MB.')
      setProof('')
      event.target.value = ''
      return
    }
    try {
      setProof(await readFile(file))
      setError('')
    } catch (fileError) {
      setError(fileError.message)
    }
  }

  async function submit(event) {
    event.preventDefault()
    if (!activeRegistration || !matchId) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await request('/player/disputes', {
        method: 'POST',
        body: JSON.stringify({
          weekId: activeRegistration.weekId,
          matchId,
          details,
          proofData: proof,
        }),
      })
      const data = await request('/player/disputes')
      setDisputes(data.disputes || [])
      setDetails('')
      setProof('')
      setNotice('Your report has been sent to the tournament organizers.')
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setBusy(false)
    }
  }

  if (!activeRegistration || activeRegistration.paymentStatus !== 'approved') return null

  return (
    <section className="player-dispute-panel">
      <span className="eyebrow">MATCH INTEGRITY</span>
      <h3>Report a match issue</h3>
      <p>Choose one of your fixtures, explain what happened, and optionally attach a screenshot.</p>
      {matches.length ? <form onSubmit={submit}>
        <label>Match
          <select value={matchId} onChange={(event) => setMatchId(event.target.value)} required>
            {matches.map((match) => <option key={match.matchId} value={match.matchId}>{match.roundName} · Match {match.matchNumber}: {match.player1?.playerName || 'TBD'} vs {match.player2?.playerName || 'TBD'}</option>)}
          </select>
        </label>
        <label>Details
          <textarea rows={3} maxLength={2000} value={details} onChange={(event) => setDetails(event.target.value)} placeholder="Describe the score or match issue…" required />
        </label>
        <label className="player-dispute-file">Screenshot proof <small>PNG, JPG or WebP · up to 5 MB</small><input type="file" accept="image/png,image/jpeg,image/webp" onChange={chooseProof} /></label>
        {proof && <small className="player-dispute-file-ready">Proof image attached</small>}
        {error && <p className="schedule-error" role="alert">{error}</p>}
        {notice && <p className="player-dispute-notice" role="status">{notice}</p>}
        <button className="primary-button" type="submit" disabled={busy || !details.trim()}>{busy ? 'Submitting…' : 'Submit report'}</button>
      </form> : <p className="player-dispute-empty">Your approved tournament fixtures are not available yet.</p>}
      {disputes.length > 0 && <div className="player-dispute-history"><strong>Your reports</strong>{disputes.map((dispute) => <article key={dispute.id}><span>Match {dispute.matchId} · {dispute.status}</span><p>{dispute.details}</p>{dispute.adminNote && <small>Organizer: {dispute.adminNote}</small>}</article>)}</div>}
    </section>
  )
}
