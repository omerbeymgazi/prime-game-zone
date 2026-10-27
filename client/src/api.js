const DEFAULT_TIMEOUT_MS = 25_000
const MAX_RETRIES = 2
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function requestId() {
  return window.crypto?.randomUUID?.()
    || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
      const random = Math.floor(Math.random() * 16)
      return (character === 'x' ? random : (random & 0x3) | 0x8).toString(16)
    })
}

export async function apiFetch(path, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = MAX_RETRIES,
    retryUnsafe = false,
    ...fetchOptions
  } = options
  const method = String(fetchOptions.method || 'GET').toUpperCase()
  const canRetry = ['GET', 'HEAD', 'OPTIONS'].includes(method) || retryUnsafe
  const headers = new Headers(fetchOptions.headers || {})
  if (fetchOptions.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (retryUnsafe && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', requestId())

  let lastError
  for (let attempt = 0; attempt <= (canRetry ? retries : 0); attempt += 1) {
    const controller = new AbortController()
    let timedOut = false
    const timeout = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const abortFromCaller = () => controller.abort(fetchOptions.signal?.reason)
    fetchOptions.signal?.addEventListener('abort', abortFromCaller, { once: true })

    try {
      const response = await fetch(path, {
        ...fetchOptions,
        credentials: fetchOptions.credentials || 'include',
        headers,
        signal: controller.signal,
      })
      if (response.ok) return response
      const data = await response.json().catch(() => ({}))
      const error = new Error(data.error || `Request failed (${response.status}).`)
      error.status = response.status
      if (!canRetry || !RETRYABLE_STATUSES.has(response.status) || attempt >= retries) throw error
      lastError = error
      const retryAfter = Number(response.headers.get('Retry-After'))
      await wait(Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 3000)
        : 350 * (2 ** attempt) + Math.random() * 150)
    } catch (error) {
      lastError = error
      if (fetchOptions.signal?.aborted || !canRetry || attempt >= retries || error.status) {
        if (timedOut && !fetchOptions.signal?.aborted) {
          throw new Error('The request timed out. Check your connection and try again.')
        }
        throw error
      }
      await wait(350 * (2 ** attempt) + Math.random() * 150)
    } finally {
      window.clearTimeout(timeout)
      fetchOptions.signal?.removeEventListener('abort', abortFromCaller)
    }
  }
  throw lastError || new Error('The request could not be completed. Please try again.')
}

export async function apiRequest(path, options = {}) {
  const response = await apiFetch(path, options)
  return response.json().catch(() => ({}))
}