/** Browser plugin entry point registering the sidebar icon, management panel, dedicated group chat panel, and Plugin Manager config view. */
import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { StatusSource } from './roster.tsx'
import { openKnownSession, SessionNavigationError } from '../navigation.ts'
import { App } from './app.tsx'
import { PluginConfig, usePageForm } from './deployment.tsx'
import { GroupChatPage } from './group-chat.tsx'
import { en, zh } from './locales.ts'
import { Roster } from './roster.tsx'
import { PanelProvider } from './provider.tsx'
import { GROUP_OPEN, currentGroupChat, requestGroupChat } from './route.ts'
import rosterStyles from './roster.css?raw'
import type { T } from './text.ts'

type ClientContext = Context & { sessions: ISessions; get?(name: string): unknown }
type LayoutLike = {
  selectPanel?: (id: MainPanelId) => void
  panelInfo?: { getSnapshot?(): PanelInfo; subscribe?(listener: () => void): () => void }
}
const NS = 'dshSuperagent'
const PANEL_ID = 'dsh-superagent' as MainPanelId
export const GROUP_PANEL_ID = 'dsh-superagent-group' as MainPanelId
const ENTRY = 'dsh-superagent'

function HammerIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M6 3.5h9l3.5 1.75v2.5L15 9.5H6a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M10 9.5v10.25a1.75 1.75 0 0 0 3.5 0V9.5" /><path d="M10 15.5h3.5" />
  </svg>
}

function useOpenSession(ctx: ClientContext, t: T) {
  const pending = useRef<AbortController>(undefined)
  useEffect(() => () => { pending.current?.abort() }, [])
  return useCallback(async (id: string) => {
    pending.current?.abort()
    const request = new AbortController(); pending.current = request
    try {
      await openKnownSession(ctx.sessions, id as SessionId, target => { ctx.uiWorkspace.openSession(target) }, request.signal)
    } catch (error) {
      if (error instanceof SessionNavigationError) throw new Error(t(error.code === 'not-ready' ? 'sessionListNotReady' : 'sessionNotListed'))
      throw error
    }
  }, [ctx, t])
}

function useSelectedGroup(): string | undefined {
  const [groupId, setGroupId] = useState<string | undefined>(() => currentGroupChat())
  useEffect(() => {
    const onOpen = (event: Event) => {
      const id = (event as CustomEvent<string>).detail
      if (typeof id === 'string' && id) setGroupId(id)
    }
    window.addEventListener(GROUP_OPEN, onOpen)
    return () => window.removeEventListener(GROUP_OPEN, onOpen)
  }, [])
  return groupId
}

function useActivePanelId(ctx: ClientContext): MainPanelId | null {
  const read = () => (ctx.get?.('layout') as LayoutLike | undefined)?.panelInfo?.getSnapshot?.()?.activePanelId ?? null
  const [active, setActive] = useState<MainPanelId | null>(read)
  useEffect(() => {
    const info = (ctx.get?.('layout') as LayoutLike | undefined)?.panelInfo
    setActive(read())
    return typeof info?.subscribe === 'function' ? info.subscribe(() => setActive(read())) : undefined
  }, [ctx])
  return active
}

/** Mounted management/settings panel wrapper. */
function Mounted({ ctx, t }: { ctx: ClientContext; t: T }) {
  const openSession = useOpenSession(ctx, t)
  const openGroupChat = useCallback((teamId: string) => {
    requestGroupChat(teamId)
    selectPanel(ctx, GROUP_PANEL_ID)
  }, [ctx])
  const form = usePageForm(ctx.get?.('configForms')?.get<Record<string, unknown>>(ENTRY))
  return <App t={t} openSession={openSession} openGroupChat={openGroupChat} deploymentForm={form} />
}

/** Mounted dedicated Group Chat panel, completely separate from the settings/management tabs. */
function MountedGroupChat({ ctx, t }: { ctx: ClientContext; t: T }) {
  const openSession = useOpenSession(ctx, t)
  const groupId = useSelectedGroup()
  return <PanelProvider t={t} openSession={openSession}>
    <GroupChatPage teamId={groupId} onOpenManage={() => selectPanel(ctx, PANEL_ID)} />
  </PanelProvider>
}

function MountedRoster({ ctx, t, wide }: { ctx: ClientContext; t: T; wide: boolean }) {
  const openSession = useOpenSession(ctx, t)
  const activePanel = useActivePanelId(ctx)
  const groupId = useSelectedGroup()
  return <RosterBoundary>
    <PanelProvider t={t} openSession={openSession}>
      <style>{rosterStyles}</style>
      <Roster wide={wide} sessions={ctx.sessions} status={sessionStatus(ctx)}
        activeGroupId={activePanel === GROUP_PANEL_ID ? groupId : undefined}
        inConversation={activePanel === null}
        openGroup={id => { requestGroupChat(id); selectPanel(ctx, GROUP_PANEL_ID) }}
        openTeam={() => selectPanel(ctx, PANEL_ID)} />
    </PanelProvider>
  </RosterBoundary>
}

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']
/** Registers the management panel, dedicated group chat panel, sidebar icon, and Plugin Manager config view. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <Mounted ctx={ctx} t={props.t} />))
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: GROUP_PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <MountedGroupChat ctx={ctx} t={props.t} />))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => t('panel'), locale: NS }, HammerIcon))
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
  // The shipped session browser registers first at the default priority and keeps the seat.
  // A lower priority sorts first and replaces it. A throw still falls back to that list.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({ name: 'sidebar.workspaces', priority: -1_000_000 },
    (props: { wide?: boolean }) => <MountedRoster ctx={ctx} t={t} wide={props.wide !== false} />))
}

function sessionStatus(ctx: ClientContext): StatusSource | undefined {
  return (ctx.get?.('uiSession') as { sessionStatus?: StatusSource } | undefined)?.sessionStatus
}
function selectPanel(ctx: ClientContext, id: MainPanelId = PANEL_ID): void {
  (ctx.get?.('layout') as LayoutLike | undefined)?.selectPanel?.(id)
}

/** Keeps a roster failure in the sidebar instead of handing the seat back to the session list. */
class RosterBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {}
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) } }
  render() { return this.state.error ? <p className="dt-roster-empty">{this.state.error}</p> : this.props.children }
}
