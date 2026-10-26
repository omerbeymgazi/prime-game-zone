import { useState } from 'react'

const REACTIONS = ['👍', '❤️', '🔥', '😂', '🙌']

function RichMessageText({ body }) {
  const tokens = body.split(/(\*\*[^*]+\*\*|\*[^*]+\*|https?:\/\/[^\s]+)/g)
  return tokens.map((token, index) => {
    if (/^https?:\/\//.test(token)) {
      let hostname = token
      try {
        hostname = new URL(token).hostname
      } catch {
        hostname = token
      }
      return (
        <a className="chat-link-preview" href={token} key={`${index}-${token}`} target="_blank" rel="noreferrer noopener">
          <strong>{hostname}</strong><span>{token}</span>
        </a>
      )
    }
    if (token.startsWith('**') && token.endsWith('**')) return <strong key={index}>{token.slice(2, -2)}</strong>
    if (token.startsWith('*') && token.endsWith('*')) return <em key={index}>{token.slice(1, -1)}</em>
    return <span key={index}>{token}</span>
  })
}

export default function ChatMessage({
  message, actor, playerName, playerAvatar, onEdit, onDelete, onPin, onReact,
}) {
  const [actionsOpen, setActionsOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.body || '')
  const [actionError, setActionError] = useState('')
  const isOwn = message.sender === actor
  const deleted = Boolean(message.deletedAt)
  const senderName = message.sender === 'admin' ? 'Prime Gaming Zone' : playerName || 'Player'
  const avatar = message.sender === 'admin' ? '/logo.png' : playerAvatar

  async function saveEdit(event) {
    event.preventDefault()
    if (await onEdit(message.id, draft)) setEditing(false)
  }

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message.body || message.attachmentName || '')
      setActionsOpen(false)
      setActionError('')
    } catch (error) {
      setActionError(error.message || 'Message could not be copied.')
    }
  }

  function deleteMessage() {
    if (window.confirm('Delete this message?')) onDelete(message.id)
  }

  return (
    <article className={`chat-message chat-message--${message.sender}${message.isPinned ? ' chat-message--pinned' : ''}`} data-message-id={message.id}>
      <span className={`chat-avatar${message.sender === 'admin' ? ' chat-avatar--brand' : ''}`}>
        {avatar ? <img src={avatar} alt="" /> : (senderName.trim()[0] || 'P').toUpperCase()}
      </span>
      <div className="chat-message-content">
        <div className="chat-message-meta"><strong>{senderName}</strong>{message.isPinned && <span>PINNED</span>}</div>
        <div className="chat-bubble">
          {editing ? (
            <form className="chat-edit-form" onSubmit={saveEdit}>
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={2000} autoFocus aria-label="Edit message" />
              <button type="submit" disabled={!draft.trim()}>Save</button>
              <button type="button" onClick={() => setEditing(false)}>Cancel</button>
            </form>
          ) : deleted ? (
            <p className="chat-deleted-message">This message was deleted.</p>
          ) : (
            <>
              {message.body && <p className="chat-message-text"><RichMessageText body={message.body} /></p>}
              {message.messageType === 'image' && message.attachmentUrl && <a href={message.attachmentUrl} target="_blank" rel="noreferrer noopener"><img className="chat-attachment-image" src={message.attachmentUrl} alt={message.attachmentName || 'Shared image'} /></a>}
              {message.messageType === 'audio' && message.attachmentUrl && <audio className="chat-attachment-audio" controls preload="metadata" src={message.attachmentUrl} />}
              {message.messageType === 'file' && message.attachmentUrl && <a className="chat-attachment-file" href={message.attachmentUrl} target="_blank" rel="noreferrer noopener" download={message.attachmentName || undefined}>📎 {message.attachmentName || 'Download attachment'}</a>}
            </>
          )}
          <div className="chat-message-footer">
            <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
            {message.editedAt && <small>edited</small>}
            {isOwn && <span className={message.readAt ? 'chat-receipt chat-receipt--read' : 'chat-receipt'} aria-label={message.readAt ? 'Read' : 'Delivered'}>{message.readAt ? '✓✓' : '✓'}</span>}
            {!deleted && <button type="button" className="chat-action-toggle" onClick={() => setActionsOpen((open) => !open)} aria-expanded={actionsOpen} aria-label="Message actions">•••</button>}
          </div>
          {actionsOpen && !deleted && (
            <div className="chat-message-actions">
              <button type="button" onClick={copyMessage}>Copy</button>
              {isOwn && <button type="button" onClick={() => { setDraft(message.body || ''); setEditing(true); setActionsOpen(false) }}>Edit</button>}
              {(isOwn || actor === 'admin') && <button type="button" onClick={deleteMessage}>Delete</button>}
              <button type="button" onClick={() => { onPin(message.id); setActionsOpen(false) }}>{message.isPinned ? 'Unpin' : 'Pin'}</button>
            </div>
          )}
        </div>
        {actionError && <p className="chat-message-action-error" role="alert">{actionError}</p>}
        {!deleted && (
          <div className="chat-reactions">
            {message.reactions?.map((reaction) => (
              <button type="button" key={reaction.emoji} className={reaction.reacted ? 'chat-reaction chat-reaction--active' : 'chat-reaction'} onClick={() => onReact(message.id, reaction.emoji)} aria-label={`${reaction.emoji}, ${reaction.count} reactions`}>
                {reaction.emoji} {reaction.count}
              </button>
            ))}
            <div className="chat-reaction-picker" aria-label="Add reaction">
              {REACTIONS.map((emoji) => <button type="button" key={emoji} onClick={() => onReact(message.id, emoji)} aria-label={`React ${emoji}`}>{emoji}</button>)}
            </div>
          </div>
        )}
      </div>
    </article>
  )
}
