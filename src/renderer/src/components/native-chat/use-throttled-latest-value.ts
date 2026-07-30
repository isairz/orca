import { useEffect, useRef, useState } from 'react'

/** Rate-limits a rapidly-changing value to at most one emit per `intervalMs`
 *  while always surfacing the latest value. OpenCode publishes a streaming
 *  assistant frame per part; unthrottled, every frame re-projects the whole
 *  transcript window.
 *
 *  Mirrors mobile/src/session/use-throttled-latest-value.ts. Kept duplicated
 *  rather than hoisted: src/shared has zero React imports by design (it is
 *  loaded by main, cli and relay), so a hook cannot live there. */
export function useThrottledLatestValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value)
  const valueRef = useRef(value)
  valueRef.current = value
  const lastEmitRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (value == null) {
      // Turn ended: drop any trailing emit and reset so the next stream's first
      // frame shows at once instead of the stale bubble lingering.
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      lastEmitRef.current = 0
      setThrottled(value)
      return
    }
    const elapsed = Date.now() - lastEmitRef.current
    if (elapsed >= intervalMs) {
      lastEmitRef.current = Date.now()
      setThrottled(value)
      return
    }
    if (timerRef.current) {
      return
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      lastEmitRef.current = Date.now()
      setThrottled(valueRef.current)
    }, intervalMs - elapsed)
  }, [value, intervalMs])

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    },
    []
  )

  return throttled
}
