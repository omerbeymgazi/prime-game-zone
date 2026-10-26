import { useEffect, useState } from 'react'

export default function LeaderboardPanel() {
  const [players, setPlayers] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    fetch('/api/leaderboard')
      .then(async (response) => {
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`)
        return data
      })
      .then((data) => {
        if (active) setPlayers(data.leaderboard || [])
      })
      .catch((requestError) => {
        if (active) setError(requestError.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  return (
    <section className="leaderboard-panel">
      <div className="leaderboard-heading"><span className="eyebrow">GLOBAL RANKING</span><h2>Champions leaderboard</h2><p>Match wins earn 3 points; each completed tournament title adds 10.</p></div>
      {loading && <p className="leaderboard-state">Loading player rankings…</p>}
      {error && <p className="schedule-error" role="alert">{error}</p>}
      {!loading && !error && !players.length && <p className="leaderboard-state">Rankings appear as official match results are recorded.</p>}
      {players.length > 0 && <div className="leaderboard-table" role="table" aria-label="Global player leaderboard">
        <div className="leaderboard-row leaderboard-row--head" role="row"><span>RANK</span><span>PLAYER</span><span>WINS</span><span>TITLES</span><span>POINTS</span></div>
        {players.slice(0, 10).map((player) => (
          <div className={`leaderboard-row${player.rank <= 3 ? ` leaderboard-row--top-${player.rank}` : ''}`} role="row" key={player.playerId}>
            <strong>#{String(player.rank).padStart(2, '0')}</strong>
            <span className="leaderboard-player-name"><b>{player.playerName}</b><small>{player.playerCode}</small></span>
            <span>{player.wins}</span><span>{player.tournamentWins}</span><strong>{player.points.toLocaleString()}</strong>
          </div>
        ))}
      </div>}
    </section>
  )
}
