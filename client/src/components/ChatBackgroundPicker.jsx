import { useEffect, useRef, useState } from 'react'
import { apiRequest } from '../api.js'

const MAX_IMAGE_SIZE = 5 * 1024 * 1024

function applyBackground(dataUrl) {
  document.documentElement.style.setProperty('--custom-app-wallpaper', `url("${dataUrl}")`)
  window.dispatchEvent(new CustomEvent('prime-chat-background-change', { detail: dataUrl }))
}

async function compressImage(file) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const dataUrl = canvas.toDataURL('image/jpeg', 0.76)
  if (dataUrl.length > 2_500_000) throw new Error('Choose a smaller background image.')
  return dataUrl
}

async function request(path, options = {}) {
  return apiRequest(`/api${path}`, options)
}

export default function ChatBackgroundPicker({ label = 'Chat background', scope = 'player', ownerId = 'player' }) {
  const inputRef = useRef(null)
  const [error, setError] = useState('')
  const storageKey = `prime-chat-background:${scope}:${scope === 'admin' ? 'organizer' : ownerId}`
  const [hasBackground, setHasBackground] = useState(() => Boolean(window.localStorage.getItem(storageKey)))

  useEffect(() => {
    let active = true
    const legacyImage = window.localStorage.getItem('prime-chat-background')
    const localImage = window.localStorage.getItem(storageKey)
    if (localImage) applyBackground(localImage)
    request(scope === 'admin' ? '/admin/chat/background' : '/player/chat/background')
      .then(async ({ imageData }) => {
        if (!active) return
        const resolvedImage = imageData || (!localImage ? legacyImage : '')
        if (resolvedImage && !imageData) {
          await request(scope === 'admin' ? '/admin/chat/background' : '/player/chat/background', {
            method: 'PUT',
            body: JSON.stringify({ imageData: resolvedImage }),
          })
        }
        if (resolvedImage) window.localStorage.setItem(storageKey, resolvedImage)
        else window.localStorage.removeItem(storageKey)
        applyBackground(resolvedImage || '')
        setHasBackground(Boolean(resolvedImage))
        setError('')
      })
      .catch((loadError) => {
        if (active) setError(loadError.message)
      })
    return () => { active = false }
  }, [scope, ownerId, storageKey])

  async function chooseImage(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/') || file.size > MAX_IMAGE_SIZE) {
      setError('Choose an image smaller than 5 MB.')
      return
    }
    try {
      const dataUrl = await compressImage(file)
      await request(scope === 'admin' ? '/admin/chat/background' : '/player/chat/background', {
        method: 'PUT',
        body: JSON.stringify({ imageData: dataUrl }),
      })
      window.localStorage.setItem(storageKey, dataUrl)
      applyBackground(dataUrl)
      setHasBackground(true)
      setError('')
    } catch (uploadError) {
      setError(uploadError.message || 'The background image could not be saved.')
    }
  }

  async function clearImage() {
    try {
      await request(scope === 'admin' ? '/admin/chat/background' : '/player/chat/background', { method: 'DELETE' })
      window.localStorage.removeItem(storageKey)
      applyBackground('')
      setHasBackground(false)
      setError('')
    } catch (removeError) {
      setError(removeError.message)
    }
  }

  return (
    <span className="chat-background-picker">
      <input ref={inputRef} type="file" accept="image/*" onChange={chooseImage} hidden />
      <button type="button" onClick={() => inputRef.current?.click()} aria-label={label}>Wallpaper</button>
      {hasBackground && <button type="button" onClick={clearImage} aria-label="Remove custom background">Reset</button>}
      {error && <span role="alert">{error}</span>}
    </span>
  )
}
