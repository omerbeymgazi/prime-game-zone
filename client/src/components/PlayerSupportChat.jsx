import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ChatBackgroundPicker from './ChatBackgroundPicker.jsx'
import ChatComposer from './ChatComposer.jsx'
import ChatMessage from './ChatMessage.jsx'
import './PlayerSupportChat.css'
import './ChatFeatures.css'

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

function dateLabel(value) {
  const date = new Date(value)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}

function playMessageSound() {
  if (!window.AudioContext) return
  try {
    const audio = new window.AudioContext()
    const oscillator = audio.createOscillator()
    const gain = audio.createGain()
    oscillator.frequency.value = 760
    gain.gain.setValueAtTime(0.015, audio.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.08)
    oscillator.connect(gain)
    gain.connect(audio.destination)
    oscillator.start()
    oscillator.stop(audio.currentTime + 0.09)
    oscillator.onended = () => audio.close()
  } catch (error) {
    console.warn('Chat notification sound could not be played:', error.message)
  }
}

export default function PlayerSupportChat({ player, lang = 'EN', theme = 'dark' }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [search, setSearch] = useState('')
  const [unreadCount, setUnreadCount] = useState(0)
  const [chatStatus, setChatStatus] = useState({})
  const [error, setError] = useState('')
  const [reportOpen, setReportOpen] = useState(false)
  const [reportReason, setReportReason] = useState('')
  const [reportNotice, setReportNotice] = useState('')
  const listRef = useRef(null)
  const messageIdsRef = useRef(new Set())
  const hasLoadedMessagesRef = useRef(false)
  const unreadCountRef = useRef(0)
  const typingTimerRef = useRef(null)
  const text = lang === 'ET'
    ? { support: 'የአስተዳደር ድጋፍ', online: 'የአስተዳደር ቡድን', intro: 'ከPrime Gaming Zone ቡድን ጋር በቀጥታ ይወያዩ።', placeholder: 'መልዕክትዎን ይጻፉ…', send: 'ላክ', close: 'ውይይቱን ዝጋ', open: 'የድጋፍ ውይይትን ክፈት', empty: 'ውይይትዎን እዚህ ይጀምሩ።' }
    : { support: 'Prime Gaming Zone', online: 'Tournament support', intro: 'Message the Prime Gaming Zone team. Replies appear here.', placeholder: 'Write a message…', send: 'Send', close: 'Close support chat', open: 'Open support chat', empty: 'Start the conversation here.' }

  const loadStatus = useCallback(async () => {
    if (!player) return
    try {
      const data = await request('/player/chat/status')
      if (!open && Number(data.unreadCount) > unreadCountRef.current) playMessageSound()
      unreadCountRef.current = Number(data.unreadCount || 0)
      setUnreadCount(data.unreadCount || 0)
      setChatStatus(data)
    } catch (requestError) {
      if (!/sign-in is required/i.test(requestError.message)) setError(requestError.message)
    }
  }, [player, open])

  const loadMessages = useCallback(async () => {
    if (!player || !open) return
    try {
      const data = await request('/player/chat')
      const messagesNext = data.messages || []
      const previousIds = messageIdsRef.current
      if (hasLoadedMessagesRef.current
        && messagesNext.some((message) => message.sender === 'admin' && !previousIds.has(String(message.id)))) playMessageSound()
      messageIdsRef.current = new Set(messagesNext.map((message) => String(message.id)))
      hasLoadedMessagesRef.current = true
      unreadCountRef.current = 0
      setMessages(messagesNext)
      setChatStatus(data)
      setUnreadCount(0)
      setError('')
    } catch (requestError) {
      setError(requestError.message)
    }
  }, [player, open])

  useEffect(() => {
    if (!player) return undefined
    const initialLoad = window.setTimeout(loadStatus, 0)
    const timer = window.setInterval(loadStatus, 6000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(timer)
    }
  }, [player, loadStatus])

  useEffect(() => {
    if (!player || !open) return undefined
    const initialLoad = window.setTimeout(loadMessages, 0)
    const timer = window.setInterval(loadMessages, 4000)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(timer)
      window.clearTimeout(typingTimerRef.current)
    }
  }, [player, open, loadMessages])

  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, open])

  const visibleMessages = useMemo(() => {
    const query = search.trim().toLowerCase()
    return messages.filter((message) => !query || (message.body || '').toLowerCase().includes(query))
  }, [messages, search])

  async function send({ body, attachment }) {
    const data = await request('/player/chat', {
      method: 'POST',
      body: JSON.stringify({
        body,
        attachmentData: attachment?.data,
        attachmentName: attachment?.name,
        messageType: attachment?.type,
      }),
    })
    setMessages((current) => [...current, data.message])
    loadStatus()
  }

  function reportTyping(typing) {
    window.clearTimeout(typingTimerRef.current)
    if (!typing) {
      request('/player/chat/typing', { method: 'POST', body: JSON.stringify({ typing: false }) }).catch((requestError) => setError(requestError.message))
      return
    }
    typingTimerRef.current = window.setTimeout(() => {
      request('/player/chat/typing', { method: 'POST', body: JSON.stringify({ typing: true }) }).catch((requestError) => setError(requestError.message))
    }, 500)
  }

  async function messageAction(messageId, action, payload) {
    setError('')
    try {
      const route = `/player/chat/messages/${messageId}`
      if (action === 'edit') await request(route, { method: 'PATCH', body: JSON.stringify({ body: payload }) })
      if (action === 'delete') await request(route, { method: 'DELETE' })
      if (action === 'pin') await request(`${route}/pin`, { method: 'PUT' })
      if (action === 'react') await request(`${route}/reactions`, { method: 'POST', body: JSON.stringify({ emoji: payload }) })
      await loadMessages()
      return true
    } catch (requestError) {
      setError(requestError.message)
      return false
    }
  }

  async function reportConversation(event) {
    event.preventDefault()
    try {
      await request('/player/chat/report', {
        method: 'POST',
        body: JSON.stringify({ reason: reportReason }),
      })
      setReportOpen(false)
      setReportReason('')
      setReportNotice('Your report was sent to the tournament organizers.')
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  if (!player) return null

  const groupedMessages = []
  for (const message of visibleMessages) {
    const label = dateLabel(message.createdAt)
    const last = groupedMessages[groupedMessages.length - 1]
    if (last?.label !== label) groupedMessages.push({ label, messages: [message] })
    else last.messages.push(message)
  }

  return (
    <aside className="player-chat-root" data-theme={theme}>
      {open && <section className="player-chat-panel" aria-label={text.support}>
        <header className="player-chat-header">
          <span className="player-chat-brand"><img src="/logo.png" alt="" /></span>
          <span className="player-chat-brand-copy"><strong>Prime Gaming Zone</strong><small><i className={chatStatus.adminOnline ? 'is-online' : ''} />{chatStatus.adminOnline ? 'Online' : 'Support team'}</small></span>
          <ChatBackgroundPicker scope="player" ownerId={player.id || player._id} />
          <button type="button" onClick={() => setOpen(false)} aria-label={text.close}>×</button>
        </header>
        <p className="player-chat-intro">{text.intro}</p>
        {chatStatus.pinned && <button type="button" className="chat-pinned-banner" onClick={() => document.querySelector(`[data-message-id="${chatStatus.pinned.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>📌 Announcement: {chatStatus.pinned.body || chatStatus.pinned.attachmentName}</button>}
        {chatStatus.blocked && <p className="chat-blocked-banner">This conversation is restricted. You can still contact the tournament organizers through the Contact Center.</p>}
        {reportNotice && <p className="chat-report-notice" role="status">{reportNotice}</p>}
        <div className="player-chat-toolbar"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search messages…" aria-label="Search messages" /><button type="button" onClick={() => setReportOpen((visible) => !visible)}>Report</button></div>
        {reportOpen && <form className="chat-report-form" onSubmit={reportConversation}><textarea rows={2} maxLength={1000} value={reportReason} onChange={(event) => setReportReason(event.target.value)} placeholder="Tell the organizers what happened…" required /><button type="submit" disabled={!reportReason.trim()}>Send report</button></form>}
        <div className="player-chat-messages chat-wallpaper" ref={listRef} aria-live="polite">
          {!visibleMessages.length && !error && <p className="player-chat-empty">{messages.length ? 'No messages match your search.' : text.empty}</p>}
          {groupedMessages.map((group) => <div className="chat-date-group" key={group.label}>
            <span>{group.label}</span>
            {group.messages.map((message) => <ChatMessage
              key={message.id}
              message={message}
              actor="player"
              playerName={player.displayName}
              playerAvatar={player.avatar}
              onEdit={(id, body) => messageAction(id, 'edit', body)}
              onDelete={(id) => messageAction(id, 'delete')}
              onPin={(id) => messageAction(id, 'pin')}
              onReact={(id, emoji) => messageAction(id, 'react', emoji)}
            />)}
          </div>)}
          {chatStatus.adminTyping && <p className="chat-typing-indicator"><i /> Prime Gaming Zone is typing…</p>}
        </div>
        {error && <p className="chat-error" role="alert">{error}</p>}
        <ChatComposer key={player.id || player._id} placeholder={chatStatus.blocked ? 'Messaging is restricted' : text.placeholder} disabled={Boolean(chatStatus.blocked)} onSend={send} onTyping={reportTyping} />
      </section>}
      <button className={`player-chat-launcher${open ? ' player-chat-launcher--open' : ''}`} type="button" aria-label={open ? text.close : text.open} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? '×' : <><span aria-hidden="true">✦</span><b>{lang === 'ET' ? 'ድጋፍ' : 'Support'}</b>{unreadCount > 0 && <i className="player-chat-unread-badge">{unreadCount > 99 ? '99+' : unreadCount}</i>}</>}
      </button>
    </aside>
  )
}
