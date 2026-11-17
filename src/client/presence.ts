/** Sidebar presence: idle, a request, working, or done until the conversation is opened. Done survives a refresh. */
import { useEffect, useRef, useState } from 'react'

export type Presence = 'idle' | 'request' | 'working' | 'done'
const MARKS = 'dsh-superagent/roster-unseen'
const VIEWING = 'dsh-superagent/roster-viewing'
const SEEN = 'dsh-superagent:roster-seen'

interface Store { get(key: string): string | null; set(key: string, value: string): void }
const browserStore: Store = {
  get: key => { try { return localStorage.getItem(key) } catch { return null } },
  set: (key, value) => { try { localStorage.setItem(key, value) } catch { /* Presence memory is a convenience. */ } },
}
let store = browserStore
/** Replace the mark store. Tests use a memory store; the browser store is the default. */
export function presenceStore(next: Store | undefined): void { store = next ?? browserStore }

function marks(): Record<string, number> {
  try {
    const value = JSON.parse(store.get(MARKS) ?? '{}') as Record<string, number>
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}
function save(value: Record<string, number>): void {
  store.set(MARKS, JSON.stringify(value))
  window.dispatchEvent(new Event(SEEN))
}

/** A conversation the person is looking at. A later finish does not light done until they leave. */
export function viewing(id: string): void { store.set(VIEWING, id); window.dispatchEvent(new Event(SEEN)) }
export function clearViewing(id: string): void {
  if (store.get(VIEWING) === id) store.set(VIEWING, '')
  window.dispatchEvent(new Event(SEEN))
}
export function isViewing(id: string): boolean { return store.get(VIEWING) === id }

/** Forget a done mark. Opening the conversation is what turns done back to idle. */
export function acknowledge(id: string): void {
  const current = marks()
  if (current[id] === undefined) return
  delete current[id]
  save(current)
}

/**
 * Presence from facts already known. A request outranks work; work outranks a finished turn the person has not opened.
 * Opening clears done.
 */
export function presenceOf(input: { request: boolean; running: boolean; open: boolean; marked: boolean }): Presence {
  if (input.request) return 'request'
  if (input.running) return 'working'
  if (input.open || !input.marked) return 'idle'
  return 'done'
}
/** Whether the done mark should remain. Work sets it; opening clears it; a finish keeps it. */
export function keepMark(marked: boolean, running: boolean, open: boolean): boolean {
  if (open) return false
  if (running) return true
  return marked
}

/** Watch conversations and remember a finish until each one is opened. Returns one presence per id. */
export function usePresence(entries: readonly { id: string; request: boolean; running: boolean; open: boolean }[]): Record<string, Presence> {
  const [, bump] = useState(0)
  const current = useRef(entries)
  current.current = entries
  const key = entries.map(item => `${item.id}:${item.request}:${item.running}:${item.open}`).join('|')
  useEffect(() => {
    const refresh = () => bump(value => value + 1)
    window.addEventListener(SEEN, refresh)
    return () => window.removeEventListener(SEEN, refresh)
  }, [])
  useEffect(() => {
    const stored = marks()
    let changed = false
    for (const item of current.current) {
      const next = keepMark(stored[item.id] !== undefined, item.running, item.open)
      if (next === (stored[item.id] !== undefined)) continue
      if (next) stored[item.id] = Date.now()
      else delete stored[item.id]
      changed = true
    }
    if (changed) save(stored)
  }, [key])
  const stored = marks()
  return Object.fromEntries(entries.map(item => [item.id, presenceOf({
    request: item.request, running: item.running, open: item.open,
    marked: keepMark(stored[item.id] !== undefined, item.running, item.open),
  })]))
}
