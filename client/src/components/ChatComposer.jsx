import { useEffect, useRef, useState } from 'react'

const MAX_FILE_SIZE = 5 * 1024 * 1024
const FILE_MIME_TYPES = {
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const ALLOWED_MIME_TYPES = new Set(Object.values(FILE_MIME_TYPES))

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The attachment could not be read.'))
    reader.onerror = () => reject(new Error('The attachment could not be read.'))
    reader.readAsDataURL(file)
  })
}

export default function ChatComposer({ placeholder, onSend, onTyping, disabled = false }) {
  const [body, setBody] = useState('')
  const [attachment, setAttachment] = useState(null)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const textRef = useRef(null)
  const fileRef = useRef(null)
  const recorderRef = useRef(null)
  const streamRef = useRef(null)

  useEffect(() => () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop()
    streamRef.current?.getTracks().forEach((track) => track.stop())
  }, [])

  function formatText(marker) {
    const field = textRef.current
    if (!field) return
    const start = field.selectionStart
    const end = field.selectionEnd
    const selected = body.slice(start, end) || 'text'
    const formatted = `${marker}${selected}${marker}`
    const next = `${body.slice(0, start)}${formatted}${body.slice(end)}`
    setBody(next)
    window.requestAnimationFrame(() => {
      field.focus()
      field.setSelectionRange(start + marker.length, start + marker.length + selected.length)
    })
  }

  async function prepareFile(file, typeOverride) {
    if (!file) return
    if (file.size > MAX_FILE_SIZE) {
      setError('Attachments must be 5 MB or smaller.')
      return
    }
    const extension = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0]
    const normalizedMime = !file.type || file.type === 'application/octet-stream'
      ? FILE_MIME_TYPES[extension]
      : file.type.split(';')[0].toLowerCase()
    if (!normalizedMime || !ALLOWED_MIME_TYPES.has(normalizedMime)) {
      setError('Choose a supported image, audio recording, or document.')
      return
    }
    if (typeOverride === 'image' && !normalizedMime.startsWith('image/')) {
      setError('Choose an image file.')
      return
    }
    try {
      const normalizedFile = normalizedMime === file.type ? file : new File([file], file.name, { type: normalizedMime })
      const messageType = typeOverride || (normalizedMime.startsWith('image/') ? 'image' : normalizedMime.startsWith('audio/') ? 'audio' : 'file')
      setAttachment({ data: await readFile(normalizedFile), name: file.name, mime: normalizedMime, type: messageType })
      setError('')
    } catch (fileError) {
      setError(fileError.message)
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError('Voice recording is not supported by this browser.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      const chunks = []
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
      recorder.onerror = () => setError('Voice recording could not be completed.')
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        if (chunks.length) {
          const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })
          await prepareFile(new File([blob], `voice-message.${blob.type.includes('mp4') ? 'm4a' : 'webm'}`, { type: blob.type }), 'audio')
        }
        setRecording(false)
      }
      recorderRef.current = recorder
      recorder.start()
      setRecording(true)
      setError('')
    } catch (recordError) {
      setError(recordError.message || 'Microphone access was denied.')
    }
  }

  async function submit(event) {
    event.preventDefault()
    if (busy || disabled || (!body.trim() && !attachment)) return
    setBusy(true)
    setError('')
    try {
      await onSend({ body: body.trim(), attachment })
      setBody('')
      setAttachment(null)
      onTyping?.(false)
    } catch (sendError) {
      setError(sendError.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="chat-composer" onSubmit={submit}>
      {attachment && <div className="chat-attachment-preview"><span>📎 {attachment.name}</span><button type="button" onClick={() => setAttachment(null)} aria-label="Remove attachment">×</button></div>}
      {error && <p className="chat-error" role="alert">{error}</p>}
      <div className="chat-format-tools" aria-label="Text formatting">
        <button type="button" onClick={() => formatText('**')} aria-label="Bold text"><b>B</b></button>
        <button type="button" onClick={() => formatText('*')} aria-label="Italic text"><i>I</i></button>
        <button type="button" onClick={() => fileRef.current?.click()} aria-label="Attach image or document">＋</button>
        <input ref={fileRef} type="file" accept="image/*,.pdf,.txt,.doc,.docx,.xls,.xlsx" hidden onChange={(event) => prepareFile(event.target.files?.[0])} />
        <button type="button" onClick={recording ? () => recorderRef.current?.stop() : startRecording} aria-pressed={recording}>{recording ? 'Stop voice' : 'Voice'}</button>
        {recording && <span className="chat-recording-indicator"><i /> Recording</span>}
      </div>
      <div className="chat-compose-row">
        <textarea
          ref={textRef}
          rows={2}
          maxLength={2000}
          value={body}
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={disabled}
          onChange={(event) => {
            setBody(event.target.value)
            onTyping?.(Boolean(event.target.value.trim()))
          }}
        />
        <button type="submit" disabled={busy || disabled || (!body.trim() && !attachment)}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    </form>
  )
}
