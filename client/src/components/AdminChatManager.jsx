import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ChatComposer from './ChatComposer.jsx'
import ChatMessage from './ChatMessage.jsx'
import './AdminChatManager.css'
import './ChatFeatures.css'
import { apiRequest } from '../api.js'

const API_BASE = '/api'

async function request(path, options = {}) {
  return apiRequest(`${API_BASE}${path}`, options)
}

function dateLabel(value) {
  const date = new Date(value)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

export default function AdminChatManager({ onError }) {
  const [chats, setChats] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [messages, setMessages] = useState([])
  const [search, setSearch] = useState('')
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [threadStatus, setThreadStatus] = useState({})
  const [selectedPlayer, setSelectedPlayer] = useState(null)
  const [actionError, setActionError] = useState('')
  const messagesRef = useRef(null)
  const selectedRef = useRef(selectedId)
  const typingTimerRef = useRef(null)
  const selected = chats.find((chat) => chat.playerId === selectedId)

  useEffect(() => { selectedRef.current = selectedId }, [selectedId])

  useEffect(() => {
    if (!selectedId) return undefined
    let active = true
    request(`/admin/chats/${selectedId}/profile`)
      .then((data) => { if (active) setSelectedPlayer(data.player) })
      .catch((error) => { if (active) setActionError(error.message) })
    return () => { active = false }
  }, [selectedId])

  const loadChats = useCallback(async () => {
    try {
      const data = await request('/admin/chats')
      setChats(data.chats || [])
      setSelectedId((current) => current || data.chats?.[0]?.playerId || '')
      setLoadError('')
    } catch (error) {
      setLoadError(error.message)
      onError?.(error.message)
    } finally {
      setLoading(false)
    }
  }, [onError])

  const loadMessages = useCallback(async () => {
    const playerId = selectedRef.current
    if (!playerId) {
      setMessages([])
      return
    }
    try {
      const data = await request(`/admin/chats/${playerId}`)
      setMessages(data.messages || [])
      setThreadStatus(data)
      setLoadError('')
    } catch (error) {
      setLoadError(error.message)
      onError?.(error.message)
    }
  }, [onError])

  useEffect(() => {
    const initialLoad = window.setTimeout(loadChats, 0)
    const timer = window.setInterval(loadChats, 8000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(timer)
    }
  }, [loadChats])

  useEffect(() => {
    const initialLoad = window.setTimeout(loadMessages, 0)
    const timer = window.setInterval(loadMessages, 4000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(timer)
      window.clearTimeout(typingTimerRef.current)
    }
  }, [selectedId, loadMessages])

  useEffect(() => {
    if (messagesRef.current) messagesRef.current.scrollTop = messagesRef.current.scrollHeight
  }, [messages])

  const visibleMessages = useMemo(() => {
    const query = search.trim().toLowerCase()
    return messages.filter((message) => !query || (message.body || '').toLowerCase().includes(query))
  }, [messages, search])

  async function send({ body, attachment }) {
    if (!selectedId) return
    const data = await request(`/admin/chats/${selectedId}`, {
      method: 'POST',
      body: JSON.stringify({
        body,
        attachmentData: attachment?.data,
        attachmentName: attachment?.name,
        messageType: attachment?.type,
      }),
    })
    setMessages((current) => [...current, data.message])
    await loadChats()
  }

  function reportTyping(typing) {
    window.clearTimeout(typingTimerRef.current)
    if (!selectedId) return
    if (!typing) {
      request(`/admin/chats/${selectedId}/typing`, { method: 'POST', body: JSON.stringify({ typing: false }) }).catch((error) => setActionError(error.message))
      return
    }
    typingTimerRef.current = window.setTimeout(() => {
      request(`/admin/chats/${selectedId}/typing`, { method: 'POST', body: JSON.stringify({ typing: true }) }).catch((error) => setActionError(error.message))
    }, 500)
  }

  async function messageAction(messageId, action, payload) {
    setActionError('')
    try {
      const route = `/admin/chats/${selectedId}/messages/${messageId}`
      if (action === 'edit') await request(route, { method: 'PATCH', body: JSON.stringify({ body: payload }) })
      if (action === 'delete') await request(route, { method: 'DELETE' })
      if (action === 'pin') await request(`${route}/pin`, { method: 'PUT' })
      if (action === 'react') await request(`${route}/reactions`, { method: 'POST', body: JSON.stringify({ emoji: payload }) })
      await loadMessages()
      return true
    } catch (error) {
      setActionError(error.message)
      return false
    }
  }

  async function moderate(blocked, clearReport = false) {
    try {
      await request(`/admin/chats/${selectedId}/moderation`, {
        method: 'PATCH',
        body: JSON.stringify({ blocked, clearReport }),
      })
      await loadChats()
      await loadMessages()
    } catch (error) {
      setActionError(error.message)
    }
  }

  const groupedMessages = []
  for (const message of visibleMessages) {
    const label = dateLabel(message.createdAt)
    const last = groupedMessages[groupedMessages.length - 1]
    if (last?.label !== label) groupedMessages.push({ label, messages: [message] })
    else last.messages.push(message)
  }

  return (
    <section className="admin-chat-manager" aria-label="Player support conversations">
      <aside className="admin-chat-inbox">
        <header>
          <span className="admin-kicker">PRIME GAMING ZONE</span>
          <h3>Support inbox</h3>
          <small>{chats.length} conversations · refreshes live</small>
        </header>
        {loading && <p className="admin-chat-empty">Loading conversations…</p>}
        {loadError && <p className="admin-error" role="alert">{loadError}</p>}
        {!loading && chats.length === 0 && <p className="admin-chat-empty">Player support conversations appear here after a player starts a chat.</p>}
        <div className="admin-chat-list">
          {chats.map((chat) => (
            <button type="button" key={chat.playerId} className={`admin-chat-person${selectedId === chat.playerId ? ' admin-chat-person--active' : ''}`} onClick={() => { setSelectedPlayer(null); setSelectedId(chat.playerId) }}>
              <span className="admin-chat-avatar">{(chat.displayName || 'P').slice(0, 1).toUpperCase()}<i className={chat.playerOnline ? 'admin-presence admin-presence--online' : 'admin-presence'} /></span>
              <span className="admin-chat-person-copy"><strong>{chat.displayName || 'Player'}</strong><small>{chat.latestMessage || 'No messages yet'}</small></span>
              {chat.reported && <i className="admin-chat-reported" aria-label="Player report pending">!</i>}
              {Number(chat.unreadCount) > 0 && <i className="admin-chat-unread">{chat.unreadCount}</i>}
              {chat.blocked && <i className="admin-chat-blocked" aria-label="Player blocked">Blocked</i>}
            </button>
          ))}
        </div>
      </aside>
      <div className="admin-chat-thread">
        {selected ? <>
          <header className="admin-chat-thread-header">
            <span className="admin-chat-brand"><img src="/logo.png" alt="" /></span>
            <span className="admin-chat-brand-copy"><strong>Prime Gaming Zone</strong><small>{selected.displayName} · {selected.playerCode || selected.playerId}</small></span>
            <span className="chat-online-status"><i className={threadStatus.playerOnline ? 'is-online' : ''} />{threadStatus.playerOnline ? 'Online' : 'Offline'}</span>
          </header>
          {threadStatus.reported && <div className="admin-chat-report-banner"><span><strong>Player report</strong>{threadStatus.reportReason}</span><button type="button" onClick={() => moderate(Boolean(threadStatus.blocked), true)}>Resolve report</button></div>}
          {threadStatus.blocked && <p className="admin-chat-blocked-banner">This player is blocked from messaging support.</p>}
          {threadStatus.pinned && <button type="button" className="chat-pinned-banner" onClick={() => document.querySelector(`[data-message-id="${threadStatus.pinned.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>📌 Pinned: {threadStatus.pinned.body || threadStatus.pinned.attachmentName}</button>}
          <div className="admin-chat-toolbar"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search this conversation…" aria-label="Search messages" /><span>{threadStatus.playerTyping ? 'Typing…' : `${messages.length} messages`}</span></div>
          <div className="admin-chat-thread-messages chat-wallpaper" ref={messagesRef} aria-live="polite">
            {!visibleMessages.length && <p className="admin-chat-empty">{messages.length ? 'No messages match your search.' : 'No messages in this conversation yet.'}</p>}
            {groupedMessages.map((group) => <div className="chat-date-group" key={group.label}>
              <span>{group.label}</span>
              {group.messages.map((message) => <ChatMessage
                key={message.id}
                message={message}
                actor="admin"
                playerName={selected.displayName}
                playerAvatar={selectedPlayer?.avatar}
                onEdit={(id, body) => messageAction(id, 'edit', body)}
                onDelete={(id) => messageAction(id, 'delete')}
                onPin={(id) => messageAction(id, 'pin')}
                onReact={(id, emoji) => messageAction(id, 'react', emoji)}
              />)}
            </div>)}
          </div>
          {actionError && <p className="chat-error" role="alert">{actionError}</p>}
          <div className="admin-chat-thread-controls"><button type="button" onClick={() => moderate(!threadStatus.blocked)}>{threadStatus.blocked ? 'Unblock player' : 'Block player'}</button></div>
          <ChatComposer key={selectedId} placeholder={`Reply to ${selected.displayName}…`} disabled={Boolean(threadStatus.blocked)} onSend={send} onTyping={reportTyping} />
        </> :                 <div className="admin-chat-no-selection"><span>✦</span><h3>Select a conversation</h3><p>Choose a player from the inbox to read and reply.</p></div>}
      </div>
    </section>
  )
}
