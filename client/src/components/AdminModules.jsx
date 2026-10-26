import { useCallback, useEffect, useState } from 'react'

const API_BASE = '/api'

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

export function AdminFinancePanel({ onError }) {
  const [report, setReport] = useState(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    try {
      setReport(await request('/admin/finance'))
      onError?.('')
    } catch (error) {
      onError?.(error.message)
    } finally {
      setLoading(false)
    }
  }, [onError])
  useEffect(() => {
    const timer = window.setTimeout(load, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  if (loading) return <p className="admin-loading">Loading financial overview…</p>
  if (!report) return <p className="admin-empty">Financial data is unavailable.</p>
  const format = (value) => `${Number(value || 0).toLocaleString()} ETB`
  return (
    <section className="admin-finance-panel">
      <div className="admin-section-heading"><div><span className="admin-kicker">FINANCIAL OVERVIEW</span><h2>Competition finances</h2><p>Approved entry collections, configured prize pools and estimated net after completed events.</p></div></div>
      <div className="admin-finance-grid">
        <article><span>ENTRY FEES COLLECTED</span><strong>{format(report.collectedEntryFees)}</strong><small>{Number(report.approvedEntries).toLocaleString()} approved entries</small></article>
        <article><span>PRIZE POOLS DISTRIBUTED</span><strong>{format(report.distributedPrizePools)}</strong><small>Completed tournaments</small></article>
        <article><span>PRIZE POOLS COMMITTED</span><strong>{format(report.committedPrizePools)}</strong><small>Upcoming and active tournaments</small></article>
        <article className="admin-finance-net"><span>NET AFTER DISTRIBUTED PRIZES</span><strong>{format(report.netAfterDistributedPrizes)}</strong><small>Collected fees less configured completed prize pools</small></article>
      </div>
      <p className="admin-finance-note">{report.note}</p>
    </section>
  )
}

export function AdminDisputesPanel({ onError, onNotice }) {
  const [disputes, setDisputes] = useState([])
  const [notes, setNotes] = useState({})
  const [busyId, setBusyId] = useState('')
  const load = useCallback(async () => {
    try {
      const data = await request('/admin/disputes')
      setDisputes(data.disputes || [])
      setNotes((current) => Object.fromEntries((data.disputes || []).map((item) => [item.id, current[item.id] ?? item.adminNote ?? ''])))
    } catch (error) {
      onError?.(error.message)
    }
  }, [onError])
  useEffect(() => {
    const initialLoad = window.setTimeout(load, 0)
    const timer = window.setInterval(load, 30_000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(timer)
    }
  }, [load])

  async function update(dispute, status) {
    setBusyId(String(dispute.id))
    try {
      await request(`/admin/disputes/${dispute.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, adminNote: notes[dispute.id] || '' }),
      })
      await load()
      onNotice?.(`Dispute ${status}.`)
    } catch (error) {
      onError?.(error.message)
    } finally {
      setBusyId('')
    }
  }

  return (
    <section className="admin-disputes-panel">
      <div className="admin-section-heading"><div><span className="admin-kicker">MATCH INTEGRITY</span><h2>Player disputes</h2><p>Review match reports, inspect uploaded proof and document the resolution.</p></div><button className="admin-secondary" type="button" onClick={load}>Refresh</button></div>
      {disputes.length === 0 ? <p className="admin-empty">There are no submitted match disputes.</p> : (
        <div className="admin-dispute-list">{disputes.map((dispute) => (
          <article className="admin-dispute-card" key={dispute.id}>
            <header><span><strong>{dispute.playerName}</strong><small>Prime Ethiopia Cup {Number(dispute.weekId) + 1} · {dispute.matchId}</small></span><i className={`admin-dispute-status admin-dispute-status--${dispute.status}`}>{dispute.status}</i></header>
            <p>{dispute.details}</p>
            {dispute.proofMime && <a className="admin-proof-link" href={`${API_BASE}/admin/disputes/${dispute.id}/proof`} target="_blank" rel="noreferrer">Open uploaded match proof ↗</a>}
            <label>Organizer resolution note<textarea rows={2} maxLength={2000} value={notes[dispute.id] || ''} onChange={(event) => setNotes({ ...notes, [dispute.id]: event.target.value })} /></label>
            <div className="admin-dispute-actions">
              {dispute.status !== 'resolved'
                ? <button className="admin-primary" type="button" disabled={busyId === String(dispute.id)} onClick={() => update(dispute, 'resolved')}>Resolve dispute</button>
                : <button className="admin-secondary" type="button" disabled={busyId === String(dispute.id)} onClick={() => update(dispute, 'open')}>Reopen</button>}
              {dispute.createdAt && <small>Reported {new Date(dispute.createdAt).toLocaleString()}</small>}
            </div>
          </article>
        ))}</div>
      )}
    </section>
  )
}
