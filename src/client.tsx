/**
 * dsh-llm-wiki-knowledge — client half (browser bundle).
 *
 * Mirrors the shipped "自动化任务" (schedule) page: the entry is an icon row in
 * the additive root `sidebar.panellist` list (order 20, i.e. right after
 * `schedules` at 10), and the very same id is the `key` of a page registered in
 * the root `main` **keyed** slot. The shell renders
 * `renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })`, so
 * selecting the icon swaps the whole central area for this page — no portal, no
 * drawer. The page offers:
 *   - document upload (drag/drop + file picker)
 *   - document list with live parse progress + delete + search
 *   - parsed result viewer (wiki chunks, entities, cross-links)
 *   - a knowledge-graph canvas (docs <-> entities) with zoom/pan/hover/click,
 *     drawn with inline SVG and self-measuring so it never collapses to white
 *
 * All data lives behind the host half's /kb-api routes.
 */
import { createElement as h, Fragment, useState, useEffect, useRef, useCallback, useMemo, useLayoutEffect, Component } from 'react'
import type { CSSProperties, ReactElement, MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
// Mind map rendering. `no-plugins` keeps katex / highlight.js / prismjs out of
// the bundle (they are for syntax highlighting inside map nodes, which a
// document outline never needs); markmap-view brings d3 with it.
import { Transformer } from 'markmap-lib/no-plugins'
import { Markmap } from 'markmap-view'

/** Panel id — same string keys both the sidebar icon row and the `main` page. */
const PANEL_ID = 'dsh-llm-wiki-knowledge'

/**
 * Sentinel for 「全部」 in the folder list.
 *
 * A string rather than a number because folder ids are UUIDs: any numeric
 * sentinel could one day collide with a real id, whereas no host-generated
 * folder id can ever be this value.
 */
const ALL_FOLDERS = '__all__'

// ---- API client -----------------------------------------------------------
// The host half self-hosts the /kb-api server on a fixed loopback port (see
// DEFAULT_CONFIG.apiPort in index.ts). The browser calls it via an absolute
// URL so it works regardless of how the DSH web app is served. CORS is enabled
// server-side. The port MUST match index.ts.
const API_BASE = 'http://127.0.0.1:18771'
const API = API_BASE + '/kb-api'

/** localStorage key holding a token the user pasted in by hand. */
const TOKEN_KEY = 'dsh-kb-token'

/**
 * Access-token state.
 *
 * `GET /_session` hands the token to same-machine callers (no `Origin`, or a
 * loopback `Origin`) and blanks it for everyone else, so a hostile web page
 * cannot read it out of the panel's own origin. A token pasted by hand lives in
 * localStorage and always wins; the bootstrapped one stays in memory only.
 */
let sessionToken = ''
let sessionProbed = false
let tokenNotice: ((reason: string) => void) | null = null

/** Registered by the page so the API layer can raise the token gate. */
function setTokenNotice(fn: ((reason: string) => void) | null): void {
  tokenNotice = fn
}

function manualToken(): string {
  try {
    return (localStorage.getItem(TOKEN_KEY) || '').trim()
  } catch {
    return '' // private mode / storage disabled — memory only
  }
}

function setManualToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* keep going: the session token still works this reload */ }
}

/**
 * Adopt a token the host just handed back (settings save / rotation) so the
 * page that performed the rotation keeps working without reloading.
 */
function adoptToken(token: string): void {
  const next = (token || '').trim()
  if (!next) return
  sessionToken = next
  sessionProbed = true
  // A hand-pasted token would keep winning over the rotated one; drop it.
  if (manualToken() && manualToken() !== next) setManualToken(next)
}

/** Resolve the token to send, bootstrapping once from the exempt session route. */
async function ensureToken(): Promise<string> {
  const manual = manualToken()
  if (manual) return manual
  if (sessionToken) return sessionToken
  if (sessionProbed) return ''
  sessionProbed = true
  try {
    const res = await fetch(API + '/_session')
    const json = (await res.json()) as any
    if (json?.ok) sessionToken = typeof json.token === 'string' ? json.token : ''
  } catch { /* leave empty — the gate will ask for a token by hand */ }
  return sessionToken
}

const TOKEN_HINT =
  '知识库服务已开启访问令牌保护。请在「设置」页复制令牌，粘贴到下面后连接。'

/**
 * Every API call goes through here so the token is attached in one place.
 *
 * A 401 is retried exactly once after dropping the cached token: the host
 * rotates tokens from the settings tab, and an open page is very likely still
 * holding the old one. A second 401 means the token cannot be obtained here, so
 * the page raises its manual-entry gate instead of showing "service down".
 */
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const send = async (token: string): Promise<Response> => {
    const headers: Record<string, string> = { ...(init?.headers as any) }
    if (token) headers['X-KB-Token'] = token
    return fetch(API + path, { ...init, headers })
  }

  const token = await ensureToken()
  let res = await send(token)
  if (res.status !== 401) return res

  if (token && token === manualToken()) setManualToken('')
  sessionToken = ''
  sessionProbed = false
  const fresh = await ensureToken()
  if (fresh && fresh !== token) res = await send(fresh)
  if (res.status === 401) tokenNotice?.(TOKEN_HINT)
  return res
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await apiFetch(path)
  const json = (await res.json()) as any
  if (!json.ok) throw new Error(json?.error?.message || 'request failed')
  return json as T
}

async function apiDelete(path: string): Promise<void> {
  const res = await apiFetch(path, { method: 'DELETE' })
  const json = (await res.json()) as any
  if (!json.ok) throw new Error(json?.error?.message || 'delete failed')
}

/**
 * DELETE that returns the body.
 *
 * Deleting a folder answers with `{ movedDocs, folders }`: the caller needs the
 * count of documents that got re-parented to tell the user what happened, and it
 * needs the new folder list so the tree does not have to wait for the next poll.
 */
async function apiDeleteJson<T = any>(path: string): Promise<T> {
  const res = await apiFetch(path, { method: 'DELETE' })
  const json = (await res.json()) as any
  if (!json.ok) throw new Error(json?.error?.message || 'delete failed')
  return json as T
}

/** Raw text body (the Markdown export route answers with text/markdown). */
async function apiText(path: string): Promise<string> {
  const res = await apiFetch(path)
  if (!res.ok) {
    // Errors are JSON even on the text route, so surface the real message.
    let message = `HTTP ${res.status}`
    try {
      const json = (await res.json()) as any
      message = json?.error?.message || message
    } catch { /* keep the status line */ }
    throw new Error(message)
  }
  return res.text()
}

async function apiPost(path: string): Promise<any> {
  const res = await apiFetch(path, { method: 'POST' })
  const json = (await res.json()) as any
  if (!json.ok) throw new Error(json?.error?.message || 'request failed')
  return json
}

/** POST with a JSON body (tag edits, retrieval from the settings tab). */
async function apiPostJson(path: string, body: unknown): Promise<any> {
  const res = await apiFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as any
  if (!json.ok) throw new Error(json?.error?.message || 'request failed')
  return json
}

/**
 * Absolute URL of an export file; `download` makes the server send it as an attachment.
 *
 * Downloads and `<img src>` navigations cannot carry a custom header, so the
 * token rides in the query string — `readRequestToken` on the host accepts it as
 * a fallback. By the time any of these links can be clicked, `refresh()` has
 * already gone through `ensureToken()`, so the token is in hand.
 */
function exportUrl(id: string, kind: 'md' | 'mindmap', download = false): string {
  const query: string[] = []
  if (download) query.push('download=1')
  const token = sessionToken || manualToken()
  if (token) query.push('token=' + encodeURIComponent(token))
  return `${API}/doc/${encodeURIComponent(id)}/${kind}${query.length ? '?' + query.join('&') : ''}`
}

/**
 * Minimal, dependency-free Markdown renderer for preview only.
 *
 * The generated Markdown is a known subset (h1-h3, blockquote, unordered list,
 * paragraph, horizontal rule, **bold**, `code`), and all source text is escaped
 * BEFORE inline formatting is applied — document content must never be able to
 * inject markup into the panel.
 */
function renderMarkdownLite(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
  const out: string[] = []
  let list: string[] | null = null
  let quote: string[] | null = null
  const flushList = () => { if (list) { out.push('<ul>' + list.map((li) => `<li>${li}</li>`).join('') + '</ul>'); list = null } }
  const flushQuote = () => { if (quote) { out.push('<blockquote><p>' + quote.join('<br/>') + '</p></blockquote>'); quote = null } }
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const text = line.trim()
    if (!text) { flushList(); flushQuote(); continue }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(text)) {
      flushList(); flushQuote(); out.push('<hr/>'); continue
    }
    const quoteMatch = text.match(/^>\s?(.*)$/)
    if (quoteMatch) { flushList(); (quote ??= []).push(inline(quoteMatch[1])); continue }
    flushQuote()
    const head = text.match(/^(#{1,6})\s+(.*)$/)
    if (head) {
      flushList()
      const level = Math.min(head[1].length, 3)
      out.push(`<h${level}>${inline(head[2])}</h${level}>`)
      continue
    }
    const bullet = text.match(/^[-*+]\s+(.*)$/)
    if (bullet) { (list ??= []).push(inline(bullet[1])); continue }
    flushList()
    out.push(`<p>${inline(text)}</p>`)
  }
  flushList(); flushQuote()
  return out.join('')
}

// ---- styles ---------------------------------------------------------------
// All colors come from the host's theme tokens (--dsw-alias-*, served by
// @deepseek-ai/dsh-client-ui-theme) so the page follows the app's light/dark
// palettes and accent exactly. Fallbacks mirror the dark palette and only
// matter before the theme stylesheet lands. Radii, fonts, and durations reuse
// --dsw-radius-* / --dsw-font-family / --ds-transition-duration-*.
// Host reference patterns (extracted from the theme package):
//   row separator: border-bottom .5px solid var(--dsw-alias-border-l2)
//   title 14px/22px weight 400-500 label-primary, desc 12px/18px label-tertiary
//   control surfaces: --dsw-alias-bg-module-platform, radius var(--dsw-radius-md)

const panelCss = `
/* Document card. Vertically layered on purpose: the old layout put the name and
   eight equally-weighted buttons on one line, so the name truncated first and
   「删除」 sat as loud as 「增强」. Now: identity / coverage / facts / actions. */
.kb-doc { border: 1px solid var(--dsw-alias-border-l2, #3a3d44); border-radius: var(--dsw-radius-md, 12px); padding: 12px 14px 10px; margin-bottom: 10px; background: var(--dsw-alias-bg-layer-2, #1e1f23); transition: border-color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease); }
.kb-doc:hover { border-color: var(--dsw-alias-border-l4, #4a4d55); }
.kb-doc-top { display: flex; align-items: center; gap: 8px; }
.kb-doc-name { font-weight: 500; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary, #e7e7ea); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-doc-meta { color: var(--dsw-alias-label-tertiary, #9a9aa6); font-size: 12px; line-height: 18px; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-prog { height: 4px; border-radius: 2px; background: var(--dsw-alias-interactive-bg-hover, #2a2a36); margin-top: 8px; overflow: hidden; }
.kb-prog > i { display: block; height: 100%; border-radius: 2px; background: var(--dsw-alias-state-business-primary, #4176e6); transition: width var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease); }
.kb-badge { font-size: 12px; line-height: 18px; padding: 1px 8px; border-radius: 999px; font-weight: 400; }
.kb-badge.done { color: var(--dsw-alias-state-success-primary, #22c55e); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 14%, transparent); }
.kb-badge.error { color: var(--dsw-alias-state-error-primary, #ef4444); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 14%, transparent); }
.kb-badge.busy { color: var(--dsw-alias-state-business-primary, #4176e6); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 14%, transparent); }
.kb-badge.ready { color: var(--dsw-alias-label-secondary, #b8bcc2); background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #9a9aa6) 16%, transparent); }
/* Folder sidebar. Fixed width with its own scroll so a deep tree never squeezes
   the document list; the divider is a hairline so the two panes read as one
   surface rather than two panels. */
.kb-folders { width: 216px; flex: none; border-right: .5px solid var(--dsw-alias-border-l2, #2a2a36); padding: 8px 6px 16px; overflow: auto; }
.kb-folders-title { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 2px 6px 8px; color: var(--dsw-alias-label-tertiary, #9a9aa6); font-size: 12px; line-height: 18px; }
.kb-folder-row { display: flex; align-items: center; gap: 5px; padding: 4px 6px; border-radius: var(--dsw-radius-sm, 8px); cursor: pointer; font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-secondary, #b8bcc2); transition: background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease), color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease); }
.kb-folder-row:hover { background: var(--dsw-alias-interactive-bg-hover, #20202b); color: var(--dsw-alias-label-primary, #e7e7ea); }
.kb-folder-row.on { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 12%, transparent); color: var(--dsw-alias-state-business-primary, #4176e6); }
.kb-folder-row > i { margin-left: auto; font-style: normal; font-size: 11px; color: var(--dsw-alias-label-caption, #6a6a78); }
.kb-folder-icon { font-size: 12px; line-height: 1; }
.kb-folder-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kb-folder-twisty { width: 12px; flex: none; text-align: center; font-size: 10px; color: var(--dsw-alias-label-caption, #6a6a78); transition: transform var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease); }
.kb-folder-twisty.open { transform: rotate(90deg); }
button.kb-folder-twisty { background: none; border: none; padding: 0; cursor: pointer; font-family: inherit; color: inherit; }
.kb-folder-acts { display: none; gap: 2px; }
.kb-folder-row:hover .kb-folder-acts { display: inline-flex; }
.kb-folder-row:hover > i { display: none; }
.kb-folder-acts button { background: none; border: none; padding: 0 2px; cursor: pointer; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-caption, #6a6a78); }
.kb-folder-acts button:hover { color: var(--dsw-alias-label-primary, #e7e7ea); }
.kb-folder-input { flex: 1; min-width: 0; padding: 2px 6px; border-radius: var(--dsw-radius-sm, 8px); border: 1px solid var(--dsw-alias-border-l3, #3a3a48); background: var(--dsw-alias-bg-layer-2, #20202b); color: var(--dsw-alias-label-primary, inherit); font-size: 12.5px; font-family: inherit; }
.kb-folder-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary, #4176e6); }
.kb-folder-new { margin: 6px 4px 0; padding: 8px; border: 1px solid var(--dsw-alias-border-l2, #3a3a48); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-layer-1, #1e1f23); }
.kb-folder-new-acts { display: flex; gap: 6px; margin-top: 6px; }
.kb-folder-error { margin-top: 6px; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-state-error-primary, #ef4444); }
/* Folder picker on a document card. Now a bare select on the title row rather
   than its own labelled row, so it is capped narrower than the generic select. */
.kb-doc-folder { max-width: 190px; min-width: 90px; flex: none; }
.kb-select { max-width: 240px; padding: 2px 6px; border-radius: var(--dsw-radius-sm, 8px); border: 1px solid var(--dsw-alias-border-l2, #3a3a48); background: var(--dsw-alias-bg-layer-2, #20202b); color: var(--dsw-alias-label-secondary, #b8bcc2); font-size: 12px; line-height: 18px; font-family: inherit; }
.kb-select:focus { outline: none; border-color: var(--dsw-alias-state-business-primary, #4176e6); }
.kb-btn.primary { color: var(--dsw-alias-state-business-primary, #4176e6); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 40%, transparent); }
.kb-bulkbar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; margin-bottom: 10px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 28%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 8%, transparent); border-radius: var(--dsw-radius-sm, 8px); font-size: 12.5px; line-height: 20px; color: var(--dsw-alias-label-secondary, #b8bcc2); }
.kb-bulkbar > span { flex: 1; }
.kb-chunk { border-top: .5px solid var(--dsw-alias-border-l2, #2a2a36); padding: 12px 0; }
.kb-chunk-title { font-weight: 500; font-size: 14px; line-height: 22px; margin-bottom: 4px; color: var(--dsw-alias-label-primary, #e7e7ea); }
.kb-chunk-text { color: var(--dsw-alias-label-secondary, #b8bcc2); font-size: 12.5px; line-height: 20px; max-height: 150px; overflow: auto; white-space: pre-wrap; }
.kb-pill { display: inline-block; font-size: 12px; line-height: 18px; padding: 1px 8px; border-radius: 999px; margin: 2px 4px 0 0; cursor: pointer; transition: background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease); color: var(--dsw-alias-state-business-primary, #4176e6); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 12%, transparent); }
.kb-pill:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 24%, transparent); }
.kb-pill.entity { color: var(--dsw-alias-state-success-primary, #22c55e); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 12%, transparent); }
.kb-pill.entity:hover { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 24%, transparent); }
.kb-pill.link { color: var(--dsw-alias-label-secondary, #b8bcc2); background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #9a9aa6) 16%, transparent); cursor: default; }
.kb-statusline { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #9a9aa6); display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
.kb-empty { color: var(--dsw-alias-label-tertiary, #9a9aa6); text-align: center; padding: 28px 10px; font-size: 12.5px; }
.kb-toast { position: absolute; bottom: 14px; left: 14px; right: 14px; background: var(--dsw-alias-bg-overlay, #2a2a36); border: 1px solid var(--dsw-alias-border-l3, #3a3a48); padding: 10px 14px; border-radius: var(--dsw-radius-md, 12px); font-size: 12.5px; line-height: 20px; color: var(--dsw-alias-label-primary, #e7e7ea); box-shadow: var(--dsw-shadow-lv1, 0 2px 4px rgba(0,0,0,.05)); }
.kb-err { color: var(--dsw-alias-state-error-primary, #ef4444); }
.kb-errorbox { color: var(--dsw-alias-state-error-primary, #ef4444); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 10%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 28%, transparent); border-radius: var(--dsw-radius-md, 12px); padding: 12px 14px; margin: 12px; font-size: 12.5px; line-height: 20px; }
.kb-warn { color: var(--dsw-alias-state-warn-label, #dd8629); }
.kb-graph-wrap { width: 100%; height: 100%; background: transparent; position: relative; }
.kb-graph-svg { display: block; width: 100%; height: 100%; cursor: grab; touch-action: none; }
.kb-graph-svg.dragging { cursor: grabbing; }
.kb-legend { position: absolute; left: 10px; bottom: 10px; display: flex; gap: 12px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #b8bcc2); background: var(--dsw-alias-bg-overlay, #2a2a36); padding: 6px 10px; border-radius: var(--dsw-radius-sm, 8px); border: 1px solid var(--dsw-alias-border-l3, #3a3a48); }
.kb-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
.kb-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-business-primary, #4176e6); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 32%, transparent); }
.kb-chip button { background: none; border: none; color: inherit; cursor: pointer; font-size: 13px; padding: 0; line-height: 1; }
/* Tags. A tag is a small pill in the host's business accent; the .on variant is
   the selected/assigned state, .static is a read-only display. */
.kb-tagbar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 0 16px 10px; }
.kb-tagbar-label { color: var(--dsw-alias-label-tertiary, #9a9aa6); font-size: 12px; line-height: 18px; }
.kb-tag { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 12px; line-height: 18px; font-family: inherit; cursor: pointer; color: var(--dsw-alias-label-secondary, #b8bcc2); background: transparent; border: 1px solid var(--dsw-alias-border-l2, #3a3a48); transition: background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease), color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease), border-color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease); }
.kb-tag:hover { border-color: var(--dsw-alias-state-business-primary, #4176e6); color: var(--dsw-alias-label-primary, #e7e7ea); }
.kb-tag i { font-style: normal; font-size: 11px; color: var(--dsw-alias-label-caption, #6a6a78); }
.kb-tag.on { color: var(--dsw-alias-state-business-primary, #4176e6); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 12%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 40%, transparent); }
.kb-tag.on i { color: inherit; opacity: 0.75; }
.kb-tag.static { cursor: default; }
.kb-doc-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.kb-tag-edit { margin-top: 8px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2, #3a3a48); border-radius: var(--dsw-radius-sm, 8px); background: var(--dsw-alias-bg-layer-1, #1e1f23); }
.kb-tag-edit-row { display: flex; gap: 6px; align-items: center; }
.kb-tag-edit-row .kb-search { flex: 1; }
.kb-tag-edit-hint { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-top: 8px; color: var(--dsw-alias-label-caption, #6a6a78); font-size: 11.5px; }
.kb-search { flex: 1; max-width: 280px; padding: 5px 10px; border-radius: var(--dsw-radius-sm, 8px); border: 1px solid var(--dsw-alias-border-l2, #3a3a48); background: var(--dsw-alias-bg-layer-2, #20202b); color: var(--dsw-alias-label-primary, inherit); font-size: 13px; font-family: inherit; }
.kb-search::placeholder { color: var(--dsw-alias-label-caption, #6a6a78); }
.kb-search:focus { outline: none; border-color: var(--dsw-alias-state-business-primary, #4176e6); }
.kb-doctools { display: flex; align-items: center; gap: 10px; padding: 10px 16px; }
.kb-doctools .kb-search { max-width: 240px; }
.kb-doctools-sub { font-size: 11.5px; line-height: 18px; color: var(--dsw-alias-label-caption, #6a6a78); }
.kb-graph-hint { color: var(--dsw-alias-label-tertiary, #9a9aa6); font-size: 11px; margin-left: auto; }
.kb-btn { background: transparent; border: 1px solid var(--dsw-alias-border-l2, #3a3a48); color: var(--dsw-alias-label-secondary, inherit); border-radius: var(--dsw-radius-sm, 8px); cursor: pointer; font-family: inherit; font-size: 13px; line-height: 20px; padding: 4px 12px; transition: background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease), color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease), border-color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease); }
.kb-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #20202b); color: var(--dsw-alias-label-primary, inherit); }
.kb-btn.sm { padding: 2px 10px; font-size: 12px; }
.kb-btn.on { color: var(--dsw-alias-state-business-primary, #4176e6); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 40%, transparent); }
.kb-btn:disabled { opacity: 0.5; cursor: default; }
.kb-btn.danger { color: var(--dsw-alias-state-error-primary, #ef4444); }
.kb-btn.danger:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 12%, transparent); }
.kb-btn.plain { border-color: transparent; color: var(--dsw-alias-label-tertiary, #9a9aa6); }
.kb-btn.plain:hover { color: var(--dsw-alias-label-primary, inherit); }
/* Markdown / mind-map: markmap declares its palette on .markmap itself, so the
   theme override needs one more level of specificity to win. */
.kb-mind-wrap { position: relative; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: var(--dsw-alias-bg-layer-1, #1e1f23); }
.kb-mind-svg { display: block; width: 100%; height: 100%; cursor: grab; }
.kb-mind-svg:active { cursor: grabbing; }
.kb-mind-wrap .markmap { --markmap-font: 400 13px/18px var(--dsw-font-family, system-ui, sans-serif); --markmap-text-color: var(--dsw-alias-label-primary, #e7e7ea); --markmap-circle-open-bg: var(--dsw-alias-bg-layer-3, #2a2a36); --markmap-code-bg: var(--dsw-alias-bg-module-platform, #20202b); --markmap-code-color: var(--dsw-alias-label-secondary, #b8bcc2); --markmap-a-color: var(--dsw-alias-state-business-primary, #4176e6); --markmap-a-hover-color: var(--dsw-alias-state-business-primary, #4176e6); --markmap-highlight-bg: color-mix(in srgb, var(--dsw-alias-state-warn-label, #dd8629) 30%, transparent); --markmap-highlight-node-bg: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 14%, transparent); }
.kb-mind-bar { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: .5px solid var(--dsw-alias-border-l2, #2a2a36); flex-wrap: wrap; }
.kb-mind-select { max-width: 320px; padding: 4px 8px; border-radius: var(--dsw-radius-sm, 8px); border: 1px solid var(--dsw-alias-border-l2, #3a3a48); background: var(--dsw-alias-bg-layer-2, #20202b); color: var(--dsw-alias-label-primary, inherit); font-size: 13px; font-family: inherit; }
.kb-mind-hint { color: var(--dsw-alias-label-tertiary, #9a9aa6); font-size: 11.5px; margin-left: auto; }
/* Rendered-Markdown preview (lite renderer: headings, quotes, lists, rules). */
.kb-md { color: var(--dsw-alias-label-secondary, #b8bcc2); font-size: 13px; line-height: 21px; }
.kb-md h1 { font-size: 17px; line-height: 26px; font-weight: 600; color: var(--dsw-alias-label-primary, #e7e7ea); margin: 0 0 10px; }
.kb-md h2 { font-size: 15px; line-height: 24px; font-weight: 600; color: var(--dsw-alias-label-primary, #e7e7ea); margin: 18px 0 6px; padding-bottom: 4px; border-bottom: .5px solid var(--dsw-alias-border-l2, #2a2a36); }
.kb-md h3 { font-size: 13.5px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary, #e7e7ea); margin: 12px 0 4px; }
.kb-md blockquote { margin: 6px 0; padding: 6px 12px; border-left: 3px solid var(--dsw-alias-border-l3, #3a3a48); color: var(--dsw-alias-label-tertiary, #9a9aa6); font-size: 12.5px; }
.kb-md blockquote p { margin: 0; }
.kb-md ul { margin: 4px 0 8px; padding-left: 20px; }
.kb-md li { margin: 2px 0; }
.kb-md p { margin: 6px 0; }
.kb-md hr { border: none; border-top: .5px solid var(--dsw-alias-border-l2, #2a2a36); margin: 12px 0; }
.kb-md strong { color: var(--dsw-alias-label-primary, #e7e7ea); font-weight: 600; }
.kb-md code { padding: 1px 5px; border-radius: 4px; background: var(--dsw-alias-bg-module-platform, #20202b); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.kb-md-src { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 19px; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary, #b8bcc2); background: var(--dsw-alias-bg-layer-2, #1e1f23); border: 1px solid var(--dsw-alias-border-l2, #3a3a48); border-radius: var(--dsw-radius-sm, 8px); padding: 10px 12px; }
/* The exported .md name is bookkeeping, not content: it stays on the meta line
   but dimmed and clipped, because a full path is several hundred pixels of
   monospace that says nothing the user cannot get from the MD button. */
.kb-export-name { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11.5px; color: var(--dsw-alias-label-caption, #6a6a78); opacity: .75; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- page chrome ------------------------------------------------------------
   The panel used to be four stacked strips (title, tabs, enhance filter, tags)
   over a two-pane body, which ate ~150px of vertical space before any content
   appeared. It is now two strips: a title row, then ONE toolbar that carries the
   tab switch and the enhancement filter as two segments of the same control
   family, so they read as one row of switches rather than two loose ones. */
.kb-title { display: flex; align-items: center; gap: 10px; padding: 14px 20px 12px; }
.kb-title-text { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #e7e7ea); }
.kb-title-sub { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-caption, #6a6a78); }
.kb-title-note { margin-left: 8px; color: var(--dsw-alias-state-warn-label, #dd8629); }
.kb-toolbar { display: flex; align-items: center; gap: 10px; padding: 0 20px 14px; flex-wrap: wrap; }
.kb-seg { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-layer-2, #1e1f23); border: 1px solid var(--dsw-alias-border-l2, #2a2a36); }
.kb-seg-label { padding: 0 6px 0 8px; color: var(--dsw-alias-label-caption, #6a6a78); font-size: 12px; line-height: 18px; }
.kb-seg button { border: none; background: transparent; color: var(--dsw-alias-label-tertiary, #9a9aa6); padding: 4px 12px; border-radius: var(--dsw-radius-sm, 8px); cursor: pointer; font-family: inherit; font-size: 13px; line-height: 20px; white-space: nowrap; transition: background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease), color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease); }
.kb-seg button:hover { color: var(--dsw-alias-label-primary, #e7e7ea); }
.kb-seg button.on { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 18%, transparent); color: var(--dsw-alias-label-primary, #e7e7ea); }
.kb-seg button i { font-style: normal; margin-left: 5px; font-size: 11px; color: var(--dsw-alias-label-caption, #6a6a78); }
.kb-seg button.on i { color: var(--dsw-alias-state-business-primary, #4176e6); }

/* ---- document list ----------------------------------------------------------
   The card used to squeeze name + 8 buttons onto one line, which broke the name
   and made every action the same weight. It is now a small vertical stack: title,
   facts, coverage, then an action row that separates navigation (left) from jobs
   (right) so "MD / 脑图 / 查看" never competes with "增强 / 重新提取 / 删除". */
.kb-doc-head { display: flex; align-items: center; gap: 8px; }
.kb-doc-cov { display: flex; align-items: center; gap: 10px; }
.kb-doc-cov-bar { flex: 1; min-width: 60px; max-width: 300px; height: 4px; border-radius: 2px; background: var(--dsw-alias-interactive-bg-hover, #2a2a36); overflow: hidden; }
.kb-doc-cov-bar > i { display: block; height: 100%; border-radius: 2px; background: var(--dsw-alias-state-business-primary, #4176e6); transition: width var(--ds-transition-duration, .2s) var(--ds-ease-in-out, ease); }
.kb-doc-cov-bar.full > i { background: var(--dsw-alias-state-success-primary, #22c55e); }
.kb-doc-cov-text { flex: none; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #9a9aa6); white-space: nowrap; }
.kb-doc-cov-text b { color: var(--dsw-alias-label-secondary, #b8bcc2); font-weight: 500; }
.kb-doc-acts { display: flex; align-items: center; gap: 6px; padding-top: 8px; border-top: .5px solid var(--dsw-alias-border-l2, #2a2a36); }
/* The list header: how many documents this view shows, where they are filed, and
   the one bulk action. The bulk button used to sit alone inside .kb-bulkbar, so
   the count and the button that acts on it were on different rows. */
.kb-listhead { display: flex; align-items: center; gap: 8px; padding: 0 16px 8px; font-size: 12.5px; line-height: 20px; color: var(--dsw-alias-label-secondary, #b8bcc2); }
.kb-listhead-sub { color: var(--dsw-alias-label-caption, #6a6a78); font-size: 11.5px; }

/* The drop target now lives inside the folder rail, directly above the tree, so
   "where does this file land" is answered by what is highlighted right below it
   instead of by a full-width sentence the user has to read. */
.kb-drop { border: 1.5px dashed var(--dsw-alias-border-l3, #3a3a48); border-radius: var(--dsw-radius-md, 12px); padding: 10px 8px; text-align: center; cursor: pointer; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #9a9aa6); background: transparent; transition: background var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease), border-color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease), color var(--ds-transition-duration-fast, .1s) var(--ds-ease-in-out, ease); }
.kb-drop:hover { border-color: var(--dsw-alias-border-l4, #4a4d55); color: var(--dsw-alias-label-secondary, #b8bcc2); }
.kb-drop.on { border-color: var(--dsw-alias-state-business-primary, #4176e6); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 10%, transparent); color: var(--dsw-alias-label-secondary, #b8bcc2); }
.kb-drop b { display: block; font-size: 13px; line-height: 20px; font-weight: 500; color: var(--dsw-alias-label-primary, #e7e7ea); }
.kb-drop i { font-style: normal; display: block; margin-top: 1px; color: var(--dsw-alias-label-caption, #6a6a78); }

/* ---- settings ---------------------------------------------------------------
   Five rows of "120px label | 320px control | whatever is left of the help text"
   in a 560px column left the right half of the panel empty and wrapped the help
   text to four lines. Now two cards on one grid: label above control, help text
   at full card width. */
.kb-set { max-width: 900px; margin: 0 auto; padding: 6px 20px 28px; }
.kb-set-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 14px; align-items: start; }
.kb-setcard { border: 1px solid var(--dsw-alias-border-l2, #2a2a36); border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-layer-2, #1e1f23); padding: 14px 16px 16px; }
.kb-setcard-title { display: flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 500; color: var(--dsw-alias-label-primary, #e7e7ea); margin-bottom: 12px; }
.kb-setfield + .kb-setfield { margin-top: 14px; }
.kb-setlabel { display: flex; align-items: baseline; gap: 6px; font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-secondary, #b8bcc2); margin-bottom: 5px; }
.kb-setcontrol { display: flex; gap: 8px; align-items: center; }
.kb-sethint { margin-top: 5px; font-size: 11.5px; line-height: 17px; color: var(--dsw-alias-label-caption, #6a6a78); }
.kb-set-foot { display: flex; gap: 8px; align-items: center; margin-top: 16px; }
`

function injectStyles(): void {
  if (typeof document === 'undefined') return
  const id = 'dsh-llm-wiki-knowledge-style'
  if (document.getElementById(id)) return
  const el = document.createElement('style')
  el.id = id
  el.textContent = panelCss
  document.head.appendChild(el)
}

// ---- shared types ----------------------------------------------------------

type Tab = 'docs' | 'mind' | 'graph' | 'settings'

interface ClientDoc {
  id: string
  name: string
  originalName: string
  mime: string
  size: number
  uploadedAt: string
  status: string
  progress: number
  error?: string
  warning?: string
  chunkCount: number
  entityCount: number
  /** Chunks that actually carry an LLM summary (<= chunkCount). */
  enhancedChunks?: number
  summary?: string
  /** File name inside <dataDir>/md/ (written when the parse finished). */
  mdFile?: string
  mindmapFile?: string
  exportedAt?: string
  /** Entry count of the document outline (list view; full outline is omitted). */
  outlineEntries?: number
  /** Present on `GET /doc/:id`: the real document outline when one was found. */
  outline?: { level: number; title: string; page: number }[]
  outlineSource?: string
  /** User-assigned labels (normalised: trimmed, lower-cased, de-duplicated). */
  tags?: string[]
  /** Owning folder; absent means the root level. */
  folderId?: string
  /** Chunks that still have no LLM summary (> 0 means 「待增强」). */
  pendingEnhance?: number
}

interface ClientFolder {
  id: string
  name: string
  parentId?: string
  createdAt?: string
  /**
   * `GET /folders` also reports how full a folder is. `path` is the list of
   * ancestor names, outermost first, EXCLUDING this folder — the tree below is
   * built from `parentId`, so the client never needs a joined string.
   */
  path?: string[]
  docCount?: number
}

/** Human label for how the mind map's structure was derived. */
function outlineLabel(doc: ClientDoc): string {
  const n = doc.outline?.length ?? doc.outlineEntries ?? 0
  if (!n) return '未找到文档目录，已按标题行归并'
  const kind = doc.outlineSource === 'pdf-bookmarks'
    ? 'PDF 目录（书签）'
    : doc.outlineSource === 'markdown-headings'
      ? 'Markdown 标题'
      : doc.outlineSource === 'text-headings'
        ? '文本标题'
        : '文档目录'
  const maxLevel = (doc.outline ?? []).reduce((m, e) => Math.max(m, e.level), 0)
  return `结构：${kind} · ${n} 条${maxLevel ? ` · 最深 ${maxLevel} 级` : ''}`
}

interface ClientChunk {
  id: string
  index: number
  title: string
  text: string
  tokens: number
  entities: string[]
  links: string[]
  summary?: string
}

interface ClientGraph {
  nodes: { id: string; label: string; kind: 'doc' | 'entity'; weight: number; docId?: string }[]
  edges: { source: string; target: string; kind: 'contains' | 'relates'; weight: number }[]
}

// ---- error boundary -------------------------------------------------------
// Insurance against a blank (white) page: if any subtree throws during render,
// we show a readable message instead of letting React unmount the whole panel.
class PageErrorBoundary extends Component<{ children: any }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return h('div', { style: { padding: 24, color: '#ff9a9a', font: '13px/1.6 system-ui' } },
        h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '知识库页面渲染出错'),
        h('div', { style: { whiteSpace: 'pre-wrap', opacity: 0.85 } }, this.state.error.message || String(this.state.error)),
      )
    }
    return this.props.children
  }
}

// ---- full-screen page ------------------------------------------------------

function KnowledgePage({ onBack }: { onBack?: () => void }) {
  const [tab, setTab] = useState<Tab>('docs')
  const [docs, setDocs] = useState<ClientDoc[]>([])
  const [status, setStatus] = useState<any>(null)
  const [detail, setDetail] = useState<{ doc: ClientDoc; chunks: ClientChunk[] } | null>(null)
  const [graph, setGraph] = useState<ClientGraph | null>(null)
  const [graphAvail, setGraphAvail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [query, setQuery] = useState('')
  const [focusEntity, setFocusEntity] = useState<string | null>(null)
  const [mdDoc, setMdDoc] = useState<ClientDoc | null>(null)
  const [mindDocId, setMindDocId] = useState<string | null>(null)
  // Tag catalog comes from the host so the filter bar lists exactly the labels
  // in use, with counts. `activeTags` is the AND-of-ORs narrowing the list.
  const [tagCatalog, setTagCatalog] = useState<{ tag: string; count: number }[]>([])
  const [activeTags, setActiveTags] = useState<string[]>([])
  const [editingTagsFor, setEditingTagsFor] = useState<string | null>(null)
  // Folder tree. `folder` is the current view: null = 根目录, plus a special
  // '__all__' for 「全部」. The tree itself is derived from the flat list the
  // host sends, because the host owns the parent links and the depth limit.
  const [folders, setFolders] = useState<ClientFolder[]>([])
  const [folder, setFolder] = useState<string | null>(null)
  const [enhanceFilter, setEnhanceFilter] = useState<'all' | 'enhanced' | 'pending'>('all')
  // Folders whose children are shown. A Set of ids rather than a "current path"
  // string, so expanding two branches at once does not collapse the first.
  const [openFolders, setOpenFolders] = useState<string[]>([])
  // Access-token gate. `tokenGate` holds the reason the API layer could not
  // authenticate; while set, the panel shows a paste box instead of the usual
  // 「service unreachable」 error, because the service is in fact running.
  const [tokenGate, setTokenGate] = useState<string | null>(null)
  const [tokenDraft, setTokenDraft] = useState('')
  const fileRef = useRef<HTMLInputElement | null>(null)
  const pollRef = useRef<number | null>(null)

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(null), 3200)
  }, [])

  // SettingsPane lives outside this component tree position but shares the
  // page toast through this module-level bridge (single-instance page).
  useEffect(() => {
    toastBridge = showToast
    return () => { toastBridge = null }
  }, [showToast])

  // Same idea for the token gate: the API layer is module-level and needs a way
  // to tell the page that a token is required but could not be bootstrapped
  // (the host only discloses it to same-machine callers).
  useEffect(() => {
    setTokenNotice((reason: string) => setTokenGate(reason))
    return () => setTokenNotice(null)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [d, s] = await Promise.all([
        apiGet<{ docs: ClientDoc[]; tags?: { tag: string; count: number }[]; folders?: ClientFolder[] }>('/docs'),
        apiGet<any>('/status'),
      ])
      setDocs(d.docs)
      setTagCatalog(d.tags ?? [])
      setFolders(d.folders ?? [])
      setStatus(s)
      setGraphAvail(s.graph.nodeCount > 0)
      setErr(null)
      setTokenGate(null)
    } catch (e) {
      setErr('无法连接知识库服务：' + (e as Error).message + '（请确认插件已加载且服务在运行）')
    }
  }, [])

  useEffect(() => {
    void refresh()
    pollRef.current = window.setInterval(() => void refresh(), 1500)
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [refresh])

  // Paste-the-token path. The stored token wins over the bootstrapped one from
  // now on, so a page that cannot reach `/_session` still works.
  const connectWithToken = useCallback(async () => {
    const token = tokenDraft.trim()
    if (!token) return
    setManualToken(token)
    setTokenDraft('')
    setTokenGate(null)
    setErr(null)
    await refresh()
  }, [refresh, tokenDraft])

  // The folder id travels as a sibling multipart field. An empty string means
  // 「根目录」 and is omitted from the form entirely so an old host build (which
  // ignores unknown fields) still receives a clean single-file body.
  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      const target = folder
      setBusy(true)
      try {
        let fellBack: string | null = null
        for (const file of Array.from(files)) {
          const fd = new FormData()
          fd.append('file', file, file.name)
          if (target) fd.append('folderId', target)
          const res = await apiFetch('/upload', { method: 'POST', body: fd })
          const json = (await res.json()) as any
          if (!json.ok) throw new Error(json?.error?.message || 'upload failed')
          if (json.folderFallback) fellBack = String(json.folderFallback)
        }
        const where = target ? folders.find((f) => f.id === target)?.name ?? '目标文件夹' : '根目录'
        showToast(
          `已上传 ${files.length} 个文件到${where}，正在本地提取（不调用 LLM）`
          + (fellBack ? `；原文件夹已不存在，文件放在根目录` : ''),
        )
        await refresh()
      } catch (e) {
        showToast('上传失败：' + (e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [folder, folders, refresh, showToast],
  )

  const removeDoc = useCallback(
    async (id: string) => {
      try {
        await apiDelete('/doc/' + encodeURIComponent(id))
        setDetail(null)
        await refresh()
      } catch (e) {
        showToast('删除失败：' + (e as Error).message)
      }
    },
    [refresh, showToast],
  )

  const openDetail = useCallback(async (doc: ClientDoc) => {
    try {
      const json = await apiGet<{ doc: ClientDoc; chunks: ClientChunk[] }>('/doc/' + encodeURIComponent(doc.id))
      setDetail(json)
    } catch (e) {
      showToast('读取失败：' + (e as Error).message)
    }
  }, [])

  // Re-extract one document. Local work only: it rebuilds chunks from the stored
  // bytes and carries every existing summary over, so this costs nothing even on
  // a document that was fully enhanced. 「LLM 增强」 is the separate job below.
  const reEnrich = useCallback(
    async (id: string) => {
      try {
        const json = await apiPost('/parse/' + encodeURIComponent(id))
        showToast(json.queued === false ? '该文档已在解析队列中' : '已开始重新提取（不调用 LLM）')
        await refresh()
      } catch (e) {
        showToast('重新提取失败：' + (e as Error).message)
      }
    },
    [refresh, showToast],
  )

  // Buy LLM summaries for the chunks that still lack one. The host runs batches
  // back to back until the whole document is covered, so this is a single click
  // that may stay busy for minutes — and pressing it twice is free, because
  // already-summarised chunks are skipped.
  const enrichDoc = useCallback(
    async (id: string) => {
      try {
        const json = await apiPost('/enrich/' + encodeURIComponent(id))
        showToast(json.note || '已开始 LLM 增强')
        await refresh()
      } catch (e) {
        showToast('LLM 增强失败：' + (e as Error).message)
      }
    },
    [refresh, showToast],
  )

  // Every document that still has unsummarised chunks, in one request. The host
  // enqueues them; the shared concurrency limit keeps the provider from being hit
  // by fifty simultaneous sweeps.
  const enrichAll = useCallback(
    async (ids: string[]) => {
      try {
        const json = await apiPostJson('/enrich-all', { docIds: ids })
        showToast(json.note || `已排入 ${json.queued} 篇文档`)
        await refresh()
      } catch (e) {
        showToast('批量增强失败：' + (e as Error).message)
      }
    },
    [refresh, showToast],
  )

  // Stop a queued/running extraction or enrichment. Finished chunks are already
  // persisted, so the document stays usable and 「增强」 picks up where this left
  // off — the already-summarised chunks are never paid for twice.
  const cancelParse = useCallback(
    async (id: string) => {
      try {
        const json = await apiPost('/cancel/' + encodeURIComponent(id))
        showToast(json.note || '已停止解析')
        await refresh()
      } catch (e) {
        showToast('停止失败：' + (e as Error).message)
      }
    },
    [refresh, showToast],
  )

  // Replace a document's whole tag list. The host normalises (trim / lower-case
  // / de-dupe) and returns the canonical list, which is what we store locally —
  // the editor therefore never has to guess how the host will spell a tag.
  const saveTags = useCallback(
    async (id: string, tags: string[]) => {
      try {
        const json = await apiPostJson('/tags/' + encodeURIComponent(id), { tags })
        const next = (json.tags ?? []) as string[]
        setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, tags: next.length ? next : undefined } : d)))
        setTagCatalog((json.catalog ?? []) as { tag: string; count: number }[])
        // Drop labels that no longer exist anywhere, so the filter bar cannot
        // keep offering a filter that can never match.
        setActiveTags((prev) => prev.filter((t) => next.includes(t) || (json.catalog ?? []).some((c: { tag: string }) => c.tag === t)))
        return true
      } catch (e) {
        showToast('保存标签失败：' + (e as Error).message)
        return false
      }
    },
    [showToast],
  )

  const loadGraph = useCallback(async () => {
    try {
      const json = await apiGet<{ graph: ClientGraph }>('/graph')
      setGraph(json.graph)
    } catch (e) {
      showToast('图谱加载失败：' + (e as Error).message)
    }
  }, [])

  useEffect(() => {
    if (tab === 'graph' && !graph) void loadGraph()
  }, [tab, graph, loadGraph])

  // The exports are written when the parse finishes, so a fresh parse also needs
  // a fresh document snapshot (which carries mdFile/exportedAt for the mind pane).
  useEffect(() => {
    if (tab === 'mind') void refresh()
  }, [tab, refresh])

  // Map entity id -> docs that contain it (from the derived graph's contains
  // edges), so clicking an entity can filter the document list.
  const entityDocIds = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const e of graph?.edges ?? []) {
      if (e.kind === 'contains') {
        const docId = (e.source.startsWith('d:') ? e.source.slice(2) : e.source)
        let set = m.get(e.target)
        if (!set) { set = new Set(); m.set(e.target, set) }
        set.add(docId)
      }
    }
    return m
  }, [graph])

  const q = query.trim().toLowerCase()
  // A document matches when it carries *any* of the active tags (OR inside,
  // AND across nothing) — tags narrow by subject, so a doc labelled both
  // 「cli」 and 「安全」 should show when either is selected.
  //
  // The folder filter keeps subfolders in scope: a document inside
  // 「手册/命令行」 should still show while 「手册」 is selected, because the
  // subtree is what the user is looking at. 「增强状态」 is derived from the two
  // counters the host already sends rather than from a separate status, since
  // 「已增强」 means every chunk carries a summary — a partially enhanced
  // document is 未增强, and the number tells the user how much is left.
  const docsInFolder = useMemo(() => {
    if (folder === ALL_FOLDERS) return docs
    if (!folder) return docs.filter((d) => !d.folderId)
    const kids = new Set<string>([folder])
    let grew = true
    while (grew) {
      grew = false
      for (const f of folders) {
        if (f.parentId && kids.has(f.parentId) && !kids.has(f.id)) {
          kids.add(f.id)
          grew = true
        }
      }
    }
    return docs.filter((d) => !!d.folderId && kids.has(d.folderId))
  }, [docs, folders, folder])

  const docsFiltered = docsInFolder.filter((d) => {
    const byName = !q || d.name.toLowerCase().includes(q) || (d.tags ?? []).some((t) => t.includes(q))
    const byEntity = !focusEntity || (entityDocIds.get('e:' + focusEntity.toLowerCase())?.has(d.id) ?? false)
    const byTag = !activeTags.length || (d.tags ?? []).some((t) => activeTags.includes(t))
    const pendingCount = d.chunkCount - (d.enhancedChunks ?? 0)
    const byEnhance = enhanceFilter === 'all'
      || (enhanceFilter === 'pending' && pendingCount > 0)
      || (enhanceFilter === 'enhanced' && d.chunkCount > 0 && pendingCount === 0)
    return byName && byEntity && byTag && byEnhance
  })

  // Documents in the current view that could still buy a summary. The bulk
  // button spends provider calls, so it acts on exactly this set and the label
  // says how many — never "增强全部" when the user has filtered down to two docs.
  const pendingInView = docsFiltered.filter((d) => d.chunkCount > (d.enhancedChunks ?? 0) && d.chunkCount > 0)
  // Both counters are corpus-wide (not view-wide) so the tab buttons tell you how
  // big a job 「未增强」 is before you switch to it. 「已增强」 is the complement of
  // 「未增强」 over documents that actually have chunks — a document that is still
  // parsing has no chunks to summarise and belongs to neither group.
  const corpus = docs.filter((d) => d.chunkCount > 0)
  const pendingTotal = corpus.filter((d) => d.chunkCount > (d.enhancedChunks ?? 0)).length
  const enhancedTotal = corpus.length - pendingTotal
  const busyCount = docs.filter((d) => d.status !== 'done' && d.status !== 'error' && d.status !== 'cancelled').length

  // Full central page (same place the Conversation renders): fills the `main`
  // slot's box instead of floating above it, exactly like 自动化任务.
  const pageStyle: CSSProperties = {
    height: '100%',
    minHeight: 0,
    background: 'var(--dsw-alias-bg-base, #151517)',
    color: 'var(--dsw-alias-label-primary, #e7e7ea)',
    fontFamily: 'var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif)',
    fontSize: 14,
    lineHeight: '22px',
    display: 'flex',
    flexDirection: 'column',
  }
  const bodyStyle: CSSProperties = { flex: 1, minHeight: 0, overflow: 'hidden', padding: 0, position: 'relative' }

  return h(PageErrorBoundary, null,
    h('div', { style: pageStyle },
      h('div', { className: 'kb-title' },
        h('span', { className: 'kb-title-text' }, '📚 知识库'),
        // The corpus counters live on the title row: they describe the whole
        // knowledge base rather than the current tab, and the document pane
        // used to repeat them above a list that already shows the same numbers
        // per document.
        h('span', { className: 'kb-title-sub' },
          status
            ? `${status.documentCount} 篇文档 · ${status.chunkCount} 个片段 · LLM 增强 ${
              status.llmBackend === 'dsh'
                ? `开（宿主 · ${status.llmModel || status.llmProvider || 'dsh'}）`
                : status.deepseekConfigured ? '开（API Key）' : '关'
            }`
            : '正在连接知识库服务…',
          status?.llmNote
            ? h('span', { className: 'kb-title-note', title: status.llmNote }, '⚠ ' + status.llmNote)
            : null),
        h('span', { style: { flex: 1 } }),
        busyCount > 0 ? h('span', { className: 'kb-badge busy' }, `进行中 ${busyCount}`) : null,
        onBack
          ? h('button', {
            onClick: onBack,
            title: '返回会话',
            className: 'kb-btn sm',
          }, '返回会话')
          : null,
      ),
      // One toolbar: the tab switch and the 增强 filter are two segments of the
      // same segmented control family, so they read as one row of switches
      // instead of two loose strips. The filter sits here rather than inside
      // DocsPane so the choice survives a trip to 脑图/图谱 and back.
      h('div', { className: 'kb-toolbar' },
        h('span', { className: 'kb-seg' },
          (['docs', 'mind', 'graph', 'settings'] as const).map((k) =>
            h('button', {
              key: k,
              className: tab === k ? 'on' : '',
              onClick: () => setTab(k),
            }, { docs: '文档', mind: '知识脑图', graph: '知识图谱', settings: '设置' }[k]))),
        h('span', { className: 'kb-seg' },
          h('span', { className: 'kb-seg-label' }, '增强'),
          (['all', 'pending', 'enhanced'] as const).map((k) =>
            h('button', {
              key: k,
              className: enhanceFilter === k ? 'on' : '',
              title: k === 'all'
                ? '显示全部文档'
                : k === 'pending'
                  ? `只显示还有片段没做 LLM 增强的文档（全库 ${pendingTotal} 篇）`
                  : '只显示已全文增强的文档',
              onClick: () => setEnhanceFilter(k),
            }, k === 'all' ? '全部' : k === 'pending' ? '未增强' : '已增强',
              h('i', null, String(k === 'all' ? docs.length : k === 'pending' ? pendingTotal : enhancedTotal)))),
        ),
      ),
      h('div', { style: bodyStyle },
        tokenGate
          ? h('div', { className: 'kb-errorbox', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('div', null, tokenGate),
              h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('input', {
                  className: 'kb-folder-input',
                  style: { flex: '1 1 320px', minWidth: 0 },
                  type: 'password',
                  placeholder: '粘贴访问令牌',
                  value: tokenDraft,
                  onInput: (e: any) => setTokenDraft(e.target.value),
                  onKeyDown: (e: any) => { if (e.key === 'Enter') void connectWithToken() },
                }),
                h('button', { className: 'kb-btn', onClick: () => void connectWithToken() }, '保存并连接')))
          : null,
        !tokenGate && err ? h('div', { className: 'kb-errorbox' }, err) : null,
        focusEntity
          ? h('div', { style: { padding: '8px 14px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { className: 'kb-chip' }, '聚焦实体：' + focusEntity,
              h('button', { title: '清除聚焦', onClick: () => setFocusEntity(null) }, '✕')))
          : null,
        // Tag filtering only narrows the document list, so the bar is shown on
        // that tab alone. On the map / graph / settings tabs it was a row of
        // controls that did nothing visible.
        tagCatalog.length && tab === 'docs'
          ? h('div', { className: 'kb-tagbar' },
            h('span', { className: 'kb-tagbar-label' }, '标签'),
            tagCatalog.map((c) =>
              h('button', {
                key: c.tag,
                className: 'kb-tag' + (activeTags.includes(c.tag) ? ' on' : ''),
                title: `${c.count} 篇文档带此标签；点击筛选`,
                onClick: () => setActiveTags((prev) => (prev.includes(c.tag) ? prev.filter((t) => t !== c.tag) : [...prev, c.tag])),
              }, c.tag, h('i', null, String(c.count)))),
            activeTags.length
              ? h('button', { className: 'kb-btn sm plain', onClick: () => setActiveTags([]) }, '清除筛选')
              : null)
          : null,
        tab === 'docs'
          ? h(DocsPane, {
            docs: docsFiltered, total: docsInFolder.length, busy, dragOver, setDragOver, onFiles, fileRef,
            allCount: docs.length,
            rootCount: docs.filter((d) => !d.folderId).length,
            openDetail, removeDoc, refresh, query, setQuery,
            onReEnrich: (id: string) => void reEnrich(id),
            onEnrich: (id: string) => void enrichDoc(id),
            onEnrichAll: (ids: string[]) => void enrichAll(ids),
            pendingInView: pendingInView.map((d) => d.id),
            folders, folder, setFolder, openFolders, setOpenFolders, setFolders, showToast,
            onCancelParse: (id: string) => void cancelParse(id),
            onFocusEntity: (e: string) => { setFocusEntity(e); setTab('graph') },
            onOpenMd: (d: ClientDoc) => setMdDoc(d),
            onOpenMind: (d: ClientDoc) => { setMindDocId(d.id); setTab('mind') },
            onSaveTags: (id: string, tags: string[]) => saveTags(id, tags),
            editingTagsFor, setEditingTagsFor,
            tagCatalog,
          })
          : tab === 'mind'
          ? h(MindPane, {
            docs: docs.filter((d) => (d.status === 'done' || d.status === 'cancelled') && d.chunkCount > 0),
            docId: mindDocId, setDocId: setMindDocId,
            onOpenMd: (d: ClientDoc) => setMdDoc(d), onToast: showToast, refresh,
          })
          : tab === 'graph'
          ? h(GraphPane, { graph, graphAvail, onReload: loadGraph, focusEntity, onFocusEntity: setFocusEntity, onOpenDoc: (id: string) => { const d = docs.find((x) => x.id === id); if (d) void openDetail(d) } })
          : h(SettingsPane, { refresh }),
        detail ? createPortal(h(DetailOverlay, { detail, onClose: () => setDetail(null), onDelete: () => removeDoc(detail.doc.id), onOpenMd: (d: ClientDoc) => setMdDoc(d), onFocusEntity: (e: string) => { setFocusEntity(e); setTab('graph') } }), document.body) : null,
        mdDoc ? createPortal(h(MdOverlay, { doc: mdDoc, onClose: () => setMdDoc(null) }), document.body) : null,
        toast ? h('div', { className: 'kb-toast' }, toast) : null,
      ),
    ),
  )
}

function DocsPane(props: {
  docs: ClientDoc[]
  /** Documents in the selected folder scope, before the search/enhance filters. */
  total: number
  /** Documents in the whole knowledge base, and those at the root level. */
  allCount: number
  rootCount: number
  busy: boolean
  dragOver: boolean
  setDragOver: (v: boolean) => void
  onFiles: (f: FileList | null) => void
  fileRef: MutableRefObject<HTMLInputElement | null>
  openDetail: (d: ClientDoc) => void
  removeDoc: (id: string) => void
  refresh: () => void
  query: string
  setQuery: (v: string) => void
  onFocusEntity: (e: string) => void
  onOpenMd: (d: ClientDoc) => void
  onOpenMind: (d: ClientDoc) => void
  onReEnrich: (id: string) => void
  onEnrich: (id: string) => void
  /** Bulk start for an explicit document list (the current filtered view). */
  onEnrichAll: (ids: string[]) => void
  /** Ids in the current view that still have unsummarised chunks. */
  pendingInView: string[]
  folders: ClientFolder[]
  folder: string | null
  setFolder: (v: string | null) => void
  openFolders: string[]
  /** `setState`-shaped: the sidebar toggles expansion with the updater form. */
  setOpenFolders: (v: string[] | ((prev: string[]) => string[])) => void
  setFolders: (v: ClientFolder[]) => void
  showToast: (msg: string) => void
  onCancelParse: (id: string) => void
  onSaveTags: (id: string, tags: string[]) => Promise<boolean>
  editingTagsFor: string | null
  setEditingTagsFor: (id: string | null) => void
  tagCatalog: { tag: string; count: number }[]
}) {
  const {
    docs, total, allCount, rootCount, busy, dragOver, setDragOver, onFiles, fileRef, openDetail, removeDoc, refresh,
    query, setQuery, onOpenMd, onOpenMind, onReEnrich, onEnrich, onEnrichAll, pendingInView, folders, folder,
    setFolder, openFolders, setOpenFolders, setFolders, showToast, onCancelParse, onSaveTags, editingTagsFor,
    setEditingTagsFor, tagCatalog,
  } = props
  const [newFolderName, setNewFolderName] = useState('')
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [editingFolder, setEditingFolder] = useState<string | null>(null)
  // Which folder currently shows its "move to…" dropdown. null = none open.
  const [movingFolder, setMovingFolder] = useState<string | null>(null)
  const [folderDraft, setFolderDraft] = useState('')
  // Folders that failed to save: keeping the draft on screen is what lets the
  // user fix a duplicate name instead of re-typing it.
  const [folderError, setFolderError] = useState('')

  // Root level first, then by name. The host holds the parent links; this builds
  // the display tree out of them so a renamed or moved folder cannot desync the
  // sidebar from the server.
  const folderTree = useMemo(() => {
    const byParent = new Map<string | undefined, ClientFolder[]>()
    for (const f of folders) {
      const k = f.parentId && folders.some((x) => x.id === f.parentId) ? f.parentId : undefined
      const list = byParent.get(k)
      if (list) list.push(f)
      else byParent.set(k, [f])
    }
    for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    const flat: { folder: ClientFolder; depth: number }[] = []
    const walk = (parentId: string | undefined, depth: number): void => {
      for (const f of byParent.get(parentId) ?? []) {
        flat.push({ folder: f, depth })
        if (openFolders.includes(f.id)) walk(f.id, depth + 1)
      }
    }
    walk(undefined, 0)
    return flat
  }, [folders, openFolders])

  const folderDocCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const d of docs) if (d.folderId) m.set(d.folderId, (m.get(d.folderId) ?? 0) + 1)
    return m
  }, [docs])

  // Direct children only, so the expand arrow appears exactly when there is
  // something below it. Derived from the same list the tree walks.
  const childCount = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of folders) if (f.parentId) m.set(f.parentId, (m.get(f.parentId) ?? 0) + 1)
    return m
  }, [folders])

  const adoptFolders = useCallback(
    (list: ClientFolder[] | undefined) => {
      if (Array.isArray(list)) setFolders(list)
    },
    [setFolders],
  )

  // The folder itself plus everything under it. The host rejects a move into
  // that set too, but the UI never offers it: a destination list containing
  // the moved folder is a trap, not a feature.
  const descendants = useCallback(
    (id: string): Set<string> => {
      const set = new Set<string>([id])
      let grew = true
      while (grew) {
        grew = false
        for (const f of folders) {
          if (f.parentId && set.has(f.parentId) && !set.has(f.id)) {
            set.add(f.id)
            grew = true
          }
        }
      }
      return set
    },
    [folders],
  )

  const createFolder = useCallback(
    async (parentId: string | null) => {
      const name = newFolderName.trim()
      if (!name) {
        setFolderError('请先输入文件夹名称')
        return
      }
      try {
        const json = await apiPostJson('/folder', { name, parentId: parentId ?? undefined })
        adoptFolders(json.folders)
        setNewFolderName('')
        setNewFolderOpen(false)
        setFolderError('')
        if (parentId) setOpenFolders((prev) => (prev.includes(parentId) ? prev : [...prev, parentId]))
        showToast('已新建文件夹「' + (json.folder?.name ?? name) + '」')
      } catch (e) {
        setFolderError('新建失败：' + (e as Error).message)
      }
    },
    [adoptFolders, newFolderName, showToast],
  )

  const renameFolder = useCallback(
    async (id: string) => {
      const name = folderDraft.trim()
      if (!name) return
      try {
        const json = await apiPostJson('/folder/' + encodeURIComponent(id), { name })
        adoptFolders(json.folders)
        setEditingFolder(null)
        setFolderError('')
        showToast('已重命名')
      } catch (e) {
        setFolderError('重命名失败：' + (e as Error).message)
        setEditingFolder(null)
      }
    },
    [adoptFolders, folderDraft, showToast],
  )

  const moveFolder = useCallback(
    async (id: string, parentId: string | null) => {
      try {
        // A move sends `parentId: ''` for the root: empty string is the explicit
        // 「放到根目录」, while omitting the key would mean 「别动父级」.
        const json = await apiPostJson('/folder/' + encodeURIComponent(id), { parentId: parentId ?? '' })
        adoptFolders(json.folders)
        if (parentId) setOpenFolders((prev) => (prev.includes(parentId) ? prev : [...prev, parentId]))
        showToast(parentId ? '已移动到「' + (folders.find((f) => f.id === parentId)?.name ?? '目标文件夹') + '」' : '已移到根目录')
      } catch (e) {
        showToast('移动失败：' + (e as Error).message)
      }
    },
    [adoptFolders, folders, showToast],
  )

  const deleteFolder = useCallback(
    async (id: string) => {
      const f = folders.find((x) => x.id === id)
      const n = folderDocCount.get(id) ?? 0
      if (f && !window.confirm(`删除文件夹「${f.name}」？${n ? `\n其中的 ${n} 篇文档会移到上一级，不会被删除。` : ''}`)) return
      try {
        const json = await apiDeleteJson('/folder/' + encodeURIComponent(id))
        adoptFolders(json.folders)
        if (folder === id) setFolder(null)
        setEditingFolder(null)
        setMovingFolder((cur) => (cur && descendants(cur).has(id) ? null : cur))
        showToast(json.movedDocs ? `已删除文件夹，${json.movedDocs} 篇文档移到了上一级` : '已删除文件夹')
      } catch (e) {
        showToast('删除失败：' + (e as Error).message)
      }
    },
    [adoptFolders, descendants, folder, folderDocCount, folders, setFolder, showToast],
  )

  const moveDoc = useCallback(
    async (id: string, folderId: string | null) => {
      try {
        const json = await apiPostJson('/doc/' + encodeURIComponent(id) + '/folder', { folderId })
        adoptFolders(json.folders)
        showToast(folderId ? '已移动到「' + (folders.find((f) => f.id === folderId)?.name ?? '目标文件夹') + '」' : '已移到根目录')
      } catch (e) {
        showToast('移动失败：' + (e as Error).message)
      }
    },
    [adoptFolders, folders, showToast],
  )
  // The upload target, search box and refresh all sit on one compact strip. The
  // full-width sentence "点击或拖拽文件到此处上传（txt / md / pdf …）" used to be
  // the biggest thing on screen and pushed the actual list below the fold; the
  // drop target itself now lives in the folder rail, directly above the tree, so
  // "where does this file land" is answered by the highlighted folder right under
  // it rather than by a sentence the user has to read.
  const target = folder ? (folders.find((f) => f.id === folder)?.name ?? '当前文件夹') : '根目录'
  return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
    h('div', { className: 'kb-doctools' },
      h('button', { className: 'kb-btn primary', onClick: () => fileRef.current?.click() },
        busy ? '上传中…' : '＋ 上传文档'),
      h('span', { className: 'kb-doctools-sub' }, '拖到左侧上传框可上传到当前文件夹'),
      h('input', { ref: fileRef, type: 'file', multiple: true, style: { display: 'none' }, onChange: (e: any) => onFiles(e.target.files) }),
      h('span', { style: { flex: 1 } }),
      h('input', {
        className: 'kb-search', placeholder: '搜索文档 / 实体…', value: query,
        onChange: (e: any) => setQuery(e.target.value),
      }),
      h('button', { className: 'kb-btn sm', onClick: () => void refresh() }, '刷新'),
    ),
    h('div', { style: { flex: 1, minHeight: 0, display: 'flex' } },
      // ---- folder sidebar ---------------------------------------------------
      // The tree is derived from the host's flat list, so a folder renamed or
      // moved in another tab cannot leave a stale copy here: every mutation
      // answers with the new list and replaces this state wholesale.
      h('div', { className: 'kb-folders' },
        h('div', {
          className: 'kb-drop' + (dragOver ? ' on' : ''),
          title: `支持 txt / md / pdf / docx / html / csv / json，上传到「${target}」`,
          onClick: () => fileRef.current?.click(),
          onDragOver: (e: any) => { e.preventDefault(); setDragOver(true) },
          onDragLeave: () => setDragOver(false),
          onDrop: (e: any) => { e.preventDefault(); setDragOver(false); onFiles(e.dataTransfer.files) },
          // The full format list lives in the title: spelled out inline it needed
          // three wrapped lines inside a 216px rail and pushed the tree down.
        }, h('b', null, busy ? '上传中…' : '拖到这里上传'), h('i', null, '→ ' + target)),
        h('div', { className: 'kb-folders-title' },
          h('span', null, '文件夹'),
          h('button', {
            className: 'kb-btn sm plain',
            title: `在${folder ? '「' + (folders.find((f) => f.id === folder)?.name ?? '当前文件夹') + '」下' : '根目录'}新建子文件夹`,
            onClick: () => { setNewFolderOpen((v) => !v); setNewFolderName(''); setFolderError('') },
          }, '＋ 新建'),
        ),
        h('div', {
          className: 'kb-folder-row' + (folder === ALL_FOLDERS ? ' on' : ''),
          onClick: () => setFolder(ALL_FOLDERS),
          title: '显示所有文件夹中的文档',
        }, h('span', { className: 'kb-folder-icon' }, '▤'), h('span', { className: 'kb-folder-name' }, '全部'),
          h('i', null, String(allCount))),
        h('div', {
          className: 'kb-folder-row' + (folder === null ? ' on' : ''),
          onClick: () => setFolder(null),
          title: '只看根目录的文档；点击上传框时文件也放这里',
        }, h('span', { className: 'kb-folder-icon' }, '📂'), h('span', { className: 'kb-folder-name' }, '根目录'),
          h('i', null, String(rootCount))),
        folderTree.map(({ folder: f, depth }) => {
          const open = openFolders.includes(f.id)
          const n = folderDocCount.get(f.id) ?? 0
          const kids = childCount.get(f.id) ?? 0
          return h('div', { className: 'kb-folder-row' + (folder === f.id ? ' on' : ''), key: f.id, style: { paddingLeft: 6 + depth * 14 }, title: f.name },
            kids
              ? h('button', {
                className: 'kb-folder-twisty' + (open ? ' open' : ''),
                title: open ? '收起' : '展开',
                onClick: (e: any) => { e.stopPropagation(); setOpenFolders((prev) => open ? prev.filter((x) => x !== f.id) : [...prev, f.id]) },
              }, '▸')
              : h('span', { className: 'kb-folder-twisty' }),
            h('span', { className: 'kb-folder-icon' }, '📁'),
            editingFolder === f.id
              ? h('input', {
                className: 'kb-folder-input',
                value: folderDraft,
                autoFocus: true,
                onClick: (e: any) => e.stopPropagation(),
                onChange: (e: any) => setFolderDraft(e.target.value),
                onKeyDown: (e: any) => {
                  if (e.key === 'Enter') { e.preventDefault(); void renameFolder(f.id) }
                  else if (e.key === 'Escape') { e.preventDefault(); setEditingFolder(null); setFolderError('') }
                },
                onBlur: () => { void renameFolder(f.id) },
              })
              : h('span', {
                className: 'kb-folder-name',
                onClick: (e: any) => { e.stopPropagation(); setFolder(f.id) },
              }, f.name),
            h('i', null, String(n)),
            h('span', { className: 'kb-folder-acts' },
              h('button', {
                title: '在「' + f.name + '」下新建子文件夹',
                onClick: (e: any) => { e.stopPropagation(); setNewFolderOpen(true); setNewFolderName(''); setFolderError(''); setFolder(f.id); setOpenFolders((prev) => (prev.includes(f.id) ? prev : [...prev, f.id])) },
              }, '＋'),
              h('button', {
                title: '重命名',
                onClick: (e: any) => { e.stopPropagation(); setEditingFolder(f.id); setFolderDraft(f.name); setFolderError('') },
              }, '✎'),
              h('button', {
                // Promote one level. Hidden at the root, where it would be a
                // no-op, and it moves the folder to the root rather than
                // guessing which sibling the user meant.
                title: f.parentId ? '移到根目录' : '已经在根目录',
                style: f.parentId ? undefined : { opacity: 0.3 },
                onClick: (e: any) => { e.stopPropagation(); if (f.parentId) void moveFolder(f.id, null) },
              }, '⇧'),
              h('button', {
                title: '移动到别的文件夹',
                onClick: (e: any) => {
                  e.stopPropagation()
                  setMovingFolder(movingFolder === f.id ? null : f.id)
                  setEditingFolder(null)
                  setFolderError('')
                },
              }, '↕'),
              h('button', {
                title: '删除文件夹（里面的文档会移到上一级，不会被删除）',
                onClick: (e: any) => { e.stopPropagation(); void deleteFolder(f.id) },
              }, '✕'),
            ),
            // Moving a folder shows the eligible destinations inline. The list
            // excludes the folder itself and its whole subtree, so the only
            // thing left to decide is WHICH parent — a cycle is not reachable
            // from this UI even if the user tries.
            movingFolder === f.id
              ? h('select', {
                className: 'kb-select',
                value: f.parentId ?? '',
                autoFocus: true,
                style: { marginTop: 4, maxWidth: '100%' },
                onClick: (e: any) => e.stopPropagation(),
                onChange: (e: any) => {
                  const target = e.target.value || null
                  setMovingFolder(null)
                  if (target !== (f.parentId ?? null)) void moveFolder(f.id, target)
                },
              },
                h('option', { value: '' }, '— 移到根目录 —'),
                folders
                  .filter((x) => !descendants(f.id).has(x.id))
                  .map((x) => h('option', { key: x.id, value: x.id }, x.name)),
              )
              : null,
          )
        }),
        newFolderOpen
          ? h('div', { className: 'kb-folder-new' },
            h('input', {
              className: 'kb-folder-input',
              placeholder: '文件夹名称',
              value: newFolderName,
              autoFocus: true,
              onChange: (e: any) => setNewFolderName(e.target.value),
              onKeyDown: (e: any) => {
                if (e.key === 'Enter') { e.preventDefault(); void createFolder(folder) }
                else if (e.key === 'Escape') { e.preventDefault(); setNewFolderOpen(false); setFolderError('') }
              },
            }),
            h('div', { className: 'kb-folder-new-acts' },
              h('button', { className: 'kb-btn sm', onClick: () => void createFolder(folder) }, '创建'),
              h('button', { className: 'kb-btn sm plain', onClick: () => { setNewFolderOpen(false); setFolderError('') } }, '取消')),
          )
          : null,
        // Outside the create form on purpose: a rename or a move that the host
        // rejected (duplicate name, depth limit) still has to be visible when no
        // form is open.
        folderError && !newFolderOpen
          ? h('div', { className: 'kb-folder-error' }, folderError)
          : null,
      ),
      // ---- document list ---------------------------------------------------
      h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
        // Bulk enhancement lives at the top of the list rather than on every
        // card: the cards would need N copies of the same button, and the count
        // is only meaningful for the whole view.
        h('div', { className: 'kb-listhead' },
          h('span', null, `${docs.length} 篇`),
          folders.length ? h('span', { className: 'kb-listhead-sub' }, target) : null,
          h('span', { style: { flex: 1 } }),
          pendingInView.length
            ? h('button', {
              className: 'kb-btn sm',
              title: '为当前视图内所有待增强文档排队 LLM 增强；会按设置中的「单批大小」自动分批跑完全文',
              onClick: () => onEnrichAll(pendingInView),
            }, `批量增强 ${pendingInView.length} 篇`)
            : null,
        ),
        h('div', { className: 'kb-bulkbar' },
          pendingInView.length
            ? h('span', null, `当前视图有 ${pendingInView.length} 篇文档待增强`)
            : h('span', null, '当前视图的文档都已全文增强'),
        ),
        h('div', { style: { flex: 1, minHeight: 0, overflow: 'auto', padding: '0 16px 16px' } },
          docs.length === 0
            ? h('div', { className: 'kb-empty' }, total === 0 ? '还没有文档。上传后会先在本地提取出片段（不调用 LLM），增强由你手动触发。' : '没有匹配的文档。')
            : null,
          docs.map((d) => {
            const pending = d.chunkCount - (d.enhancedChunks ?? 0)
            const running = d.status === 'queued' || d.status === 'extracting' || d.status === 'parsing'
              || d.status === 'enriching' || d.status === 'indexing'
            const pct = d.chunkCount > 0 ? Math.round(100 * (d.enhancedChunks ?? 0) / d.chunkCount) : 0
            return h('div', { className: 'kb-doc', key: d.id },
              // ---- row 1: what it is -----------------------------------------
              h('div', { className: 'kb-doc-head' },
                h('span', { className: 'kb-doc-name', title: d.name }, d.name),
                h('span', { className: 'kb-badge ' + badgeClass(d.status) }, statusLabel(d.status)),
                h('span', { style: { flex: 1 } }),
                // Folder assignment is a dropdown rather than a drag handle: a
                // per-card drag target is fiddly at this row height, and the
                // destination list is short enough to read.
                folders.length
                  ? h('select', {
                    className: 'kb-select kb-doc-folder',
                    title: '把文档移到别的文件夹',
                    value: d.folderId ?? '',
                    onChange: (e: any) => void moveDoc(d.id, e.target.value || null),
                  },
                    h('option', { value: '' }, '根目录'),
                    folderTree.map(({ folder: f, depth }) =>
                      h('option', { key: f.id, value: f.id }, `${'　'.repeat(depth)}${f.name}`)))
                  : null,
              ),
              // ---- row 2: how much LLM it has bought -------------------------
              d.chunkCount > 0
                ? h('div', { className: 'kb-doc-cov', title: `LLM 增强覆盖：${d.enhancedChunks ?? 0}/${d.chunkCount} 个片段` },
                  h('span', { className: 'kb-doc-cov-bar' + (pending === 0 ? ' full' : '') },
                    h('i', { style: { width: pct + '%' } })),
                  h('span', { className: 'kb-doc-cov-text' },
                    pending === 0
                      ? h(Fragment, null, '已增强 ', h('b', null, `${d.chunkCount}/${d.chunkCount}`), ' · 全文')
                      : h(Fragment, null, '已增强 ', h('b', null, `${d.enhancedChunks ?? 0}/${d.chunkCount}`), ` · ${pct}%`)))
                : null,
              // ---- row 3: the facts worth keeping ----------------------------
              h('div', { className: 'kb-doc-meta' },
                `${fmtBytes(d.size)} · ${d.chunkCount} 片段 · ${d.entityCount} 实体`
                + (d.outlineEntries ? ` · 目录 ${d.outlineEntries} 条` : '')
                + ` · ${new Date(d.uploadedAt).toLocaleString()}`,
                d.mdFile
                  ? h('span', { className: 'kb-export-name', title: `解析后导出的 Markdown 文件：md/${d.mdFile}` }, ` · md/${d.mdFile}`)
                  : null),
              editingTagsFor === d.id
                ? h(TagEditor, {
                  doc: d,
                  catalog: tagCatalog,
                  onSave: async (tags) => {
                    if (await onSaveTags(d.id, tags)) setEditingTagsFor(null)
                  },
                  onCancel: () => setEditingTagsFor(null),
                })
                : (d.tags ?? []).length
                  ? h('div', { className: 'kb-doc-tags' },
                    (d.tags ?? []).map((t) =>
                      h('span', { className: 'kb-tag static', key: t, title: '本篇文档的标签' }, t)))
                  : null,
              d.warning ? h('div', { className: 'kb-doc-meta kb-warn' }, '⚠ ' + d.warning) : null,
              running
                ? h('div', { className: 'kb-prog' }, h('i', { style: { width: d.progress + '%' } }))
                : null,
              d.status === 'error' ? h('div', { className: 'kb-err', style: { fontSize: '12px' } }, d.error) : null,
              d.status === 'cancelled'
                ? h('div', { className: 'kb-doc-meta' },
                  `已停止，已完成的部分都保留了（${d.enhancedChunks ?? 0}/${d.chunkCount}），可点「增强」接着做`)
                : null,
              // ---- row 4: the actions ----------------------------------------
              // Navigation on the left, jobs on the right. The old layout put
              // all eight on the title line, so the name broke and every action
              // had the same weight.
              h('div', { className: 'kb-doc-acts' },
                h('button', { className: 'kb-btn sm', onClick: () => openDetail(d) }, '查看'),
                (d.chunkCount > 0)
                  ? h('button', { className: 'kb-btn sm', title: '预览生成的 Markdown 文件', onClick: () => onOpenMd(d) }, 'MD')
                  : null,
                (d.chunkCount > 0)
                  ? h('button', { className: 'kb-btn sm', title: '查看知识脑图', onClick: () => onOpenMind(d) }, '脑图')
                  : null,
                h('span', { style: { flex: 1 } }),
                // One button, one job: LLM 增强. Visible whenever chunks are
                // left unsummarised, including on an `extracted` document that
                // was never enriched at all.
                pending > 0 && d.chunkCount > 0
                  ? h('button', {
                    className: 'kb-btn sm' + (running ? '' : ' primary'),
                    title: `为剩余 ${pending} 个片段调用 LLM 生成小结（已增强的不会重复调用）；会自动分批直到全文完成`,
                    onClick: () => onEnrich(d.id),
                  }, running ? '增强中…' : `增强 ${pending}`)
                  : null,
                running
                  ? h('button', {
                    className: 'kb-btn sm danger',
                    title: '停止；已完成的片段和小结都会保留，可点「增强」接着做',
                    onClick: () => onCancelParse(d.id),
                  }, '停止')
                  : null,
                d.chunkCount > 0 && (d.status === 'done' || d.status === 'extracted' || d.status === 'cancelled')
                  ? h('button', {
                    className: 'kb-btn sm plain',
                    title: '用原始文件重新提取片段与目录（不调用 LLM；已有的小结会被继承）',
                    onClick: () => onReEnrich(d.id),
                  }, '重新提取')
                  : null,
                h('button', {
                  className: 'kb-btn sm plain' + (editingTagsFor === d.id ? ' on' : ''),
                  title: '给这篇文档添加标签（可多选；标签可用于筛选，并能让 kb_search 只查这一类文档）',
                  onClick: () => setEditingTagsFor(editingTagsFor === d.id ? null : d.id),
                }, '标签'),
                h('button', { className: 'kb-btn sm plain danger', title: '删除文档及其原始文件与索引', onClick: () => removeDoc(d.id) }, '删除'),
              ),
            )
          }),
        ),
      ),
    ),
  )
}

/**
 * Inline tag editor for one document.
 *
 * Two ways in, because both are common: click an existing label to toggle it
 * (fast for the second document of a series), or type a new one. The typed
 * value is echoed as the user types but *not* de-duplicated here — the host
 * owns normalisation, and this component only ever sends the raw list, so the
 * stored result and the label under the cursor can never disagree.
 */
function TagEditor(props: {
  doc: ClientDoc
  catalog: { tag: string; count: number }[]
  onSave(tags: string[]): void | Promise<void>
  onCancel(): void
}) {
  const { doc, catalog, onSave, onCancel } = props
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState<string[]>([...(doc.tags ?? [])])
  const inputRef = useRef<HTMLInputElement | null>(null)

  // The doc object is replaced after every save; re-seed when the editor is
  // opened for a different document.
  useEffect(() => {
    setPending([...(doc.tags ?? [])])
    setDraft('')
  }, [doc.id])

  const toggle = (tag: string): void => {
    setPending((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
  }

  const addDraft = (): void => {
    const tag = draft.trim()
    if (!tag) return
    if (!pending.includes(tag)) setPending((prev) => [...prev, tag])
    setDraft('')
  }

  // Existing labels first (so the ones in use are one click away), then the
  // ones this document does not have yet.
  const suggestions = [
    ...catalog.filter((c) => pending.includes(c.tag)),
    ...catalog.filter((c) => !pending.includes(c.tag)),
  ].slice(0, 24)

  return h('div', { className: 'kb-tag-edit' },
    h('div', { className: 'kb-tag-edit-row' },
      h('input', {
        ref: inputRef,
        className: 'kb-search',
        placeholder: '输入标签后回车，如：命令行 / 安全策略',
        value: draft,
        autoFocus: true,
        onChange: (e: any) => setDraft(e.target.value),
        onKeyDown: (e: any) => {
          if (e.key === 'Enter') { e.preventDefault(); addDraft() }
          else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        },
      }),
      h('button', { className: 'kb-btn sm', onClick: addDraft, disabled: !draft.trim() }, '添加'),
      h('button', { className: 'kb-btn sm', onClick: () => onSave(pending) }, '保存'),
      h('button', { className: 'kb-btn sm plain', onClick: onCancel }, '取消'),
    ),
    pending.length
      ? h('div', { className: 'kb-doc-tags', style: { marginTop: 6 } },
        pending.map((t) =>
          h('span', { className: 'kb-tag on', key: t, title: '点击移除' },
            t, h('button', { onClick: () => toggle(t) }, '✕'))))
      : h('div', { className: 'kb-doc-meta', style: { marginTop: 6 } }, '尚未添加标签'),
    suggestions.length
      ? h('div', { className: 'kb-tag-edit-hint' },
        h('span', null, '已有标签：'),
        suggestions.map((c) =>
          h('button', {
            key: c.tag,
            className: 'kb-tag' + (pending.includes(c.tag) ? ' on' : ''),
            onClick: () => toggle(c.tag),
          }, c.tag, h('i', null, String(c.count)))))
      : null,
  )
}

function GraphPane(props: {
  graph: ClientGraph | null
  graphAvail: boolean
  onReload: () => void
  focusEntity: string | null
  onFocusEntity: (e: string) => void
  onOpenDoc: (id: string) => void
}) {
  const { graph, graphAvail, onReload, focusEntity, onFocusEntity, onOpenDoc } = props
  // Prefer live data: once a graph has loaded, always render it (this also
  // covers the case where the status snapshot predates the first build).
  if (graph) return h(GraphCanvas, { graph, onReload, focusEntity, onFocusEntity, onOpenDoc })
  if (!graphAvail) return h('div', { className: 'kb-empty' }, '暂无知识图谱。上传并解析文档后，这里会展示文档与实体之间的关系网络。')
  return h('div', { className: 'kb-empty' }, '加载中…')
}

// ---- knowledge mind map ----------------------------------------------------
// The host writes a per-document Markdown outline (<dataDir>/md/<name>.mindmap.md)
// whose tree is the document outline plus, when LLM enrichment is on, the
// per-section summary and entities. That Markdown IS the map source: markmap
// turns it into an interactive SVG here in the browser, so the host half never
// depends on a DOM.
//
// fit(maxScale) is capped: markmap's own fit() scales the whole tree into the
// window with no floor, so a manual-sized outline (thousands of entries) ends up
// as an unreadable one-pixel-wide smear. 1 is "never zoom out past actual size",
// which leaves the outer structure legible and lets the rest scroll.
const FIT_MAX_SCALE = 1

// How many rows may be PAINTED on the first paint. Past this the labels stop
// being words and become hatching, so the map opens as a table of contents you
// can read and then drill into by clicking circles.
// Measured, not guessed: markmap lays one row out to about 29px, and fit() then
// scales the whole thing into a 900px window. 24 rows (the shipped StoneOS
// manual's section list) come out at scale 1, while 274 rows measured 0.11 —
// 13px text shrunk to about 1.4px. A budget of 60 keeps the worst-case fit
// scale at roughly 0.5, which is as small as these labels stay readable.
const MIND_VISIBLE_BUDGET = 60

// Structural view of markmap's own node, declared locally so the bundle keeps
// pulling in nothing but react (the transform result is structurally this).
type MindNode = { payload?: { fold?: number; [key: string]: unknown }; children: MindNode[] }

// Pick the deepest level whose PAINTED row count still fits the budget.
// Counting the real tree (rather than regexing the Markdown) means nested lists
// and heading depth are weighed the way markmap will actually draw them.
//
// The subtlety this function exists for: a folded node is still DRAWN, as one
// clickable collapsed row, and only its own descendants disappear. So keeping
// levels 1..L visible does not paint sum(1..L) rows — it paints those plus one
// collapsed row for every level-(L+1) node. For the StoneOS manual that is
// 1 + 23 + 250 = 274 rows at L=2 versus 1 + 23 = 24 at L=1, and only L=1 is
// readable. Charging the frontier is what makes the budget honest.
function planMindDepth(root: MindNode): number {
  const perDepth: number[] = []
  const walk = (node: MindNode, depth: number): void => {
    perDepth[depth - 1] = (perDepth[depth - 1] ?? 0) + 1
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  walk(root, 1)
  // perDepth is 0-based, so keeping depth L means perDepth[0..L-1] expanded
  // plus perDepth[L] drawn as collapsed rows.
  const paintedIf = (keep: number): number => {
    let sum = 0
    for (let i = 0; i < keep; i += 1) sum += perDepth[i] ?? 0
    return sum + (perDepth[keep] ?? 0)
  }
  // The root alone always stays visible; that is the one level markmap cannot
  // fold away without leaving a single node on screen, which is a dead end.
  let depth = 1
  for (let keep = 1; keep <= perDepth.length; keep += 1) {
    if (paintedIf(keep) <= MIND_VISIBLE_BUDGET) depth = keep
  }
  return depth
}

// Fold everything below `keepDepth` before handing the tree to markmap.
// A folded node hides its own descendants, so the walk stops there instead of
// descending: marking the deepest visible node would not hide its children.
function foldBelowDepth(root: MindNode, keepDepth: number): void {
  const walk = (node: MindNode, depth: number): void => {
    if (depth > keepDepth) {
      node.payload = { ...(node.payload ?? {}), fold: 1 }
      return
    }
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  walk(root, 1)
}

function MindPane(props: {
  docs: ClientDoc[]
  docId: string | null
  setDocId: (id: string) => void
  onOpenMd: (d: ClientDoc) => void
  onToast: (m: string) => void
  refresh: () => void
}) {
  const { docs, docId, setDocId, onOpenMd, onToast, refresh } = props
  const active = docs.find((d) => d.id === docId) ?? docs[0] ?? null
  const activeId = active?.id ?? ''
  const activeExported = active?.exportedAt ?? ''
  const [md, setMd] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const mapRef = useRef<Markmap | null>(null)

  // Keep the selection pointing at a document that still exists.
  useEffect(() => {
    if (active && active.id !== docId) setDocId(active.id)
  }, [active, docId, setDocId])

  useEffect(() => {
    if (!activeId) {
      setMd(null)
      setErr(null)
      return
    }
    let alive = true
    setLoading(true)
    setErr(null)
    apiGet<{ markdown: string }>('/doc/' + encodeURIComponent(activeId) + '/mindmap')
      .then((json) => { if (alive) setMd(json.markdown) })
      .catch((e) => { if (alive) { setErr((e as Error).message); setMd(null) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [activeId, activeExported])

  // Render (and re-render) the map whenever the outline text changes. markmap
  // owns the <svg> subtree, so this effect fully tears it down on cleanup.
  //
  // Readability has two independent guards, because either one alone is useless:
  // 1. Expansion is planned from the real node tree (see planMindDepth), so a
  //    5613-entry manual opens as its section table instead of one screen of
  //    hatching. markmap's own initialExpandLevel cannot do this: it folds every
  //    node at or below the level, so level 1 folds the ROOT away and leaves a
  //    single lonely circle. We therefore pre-fold the tree ourselves and pass
  //    -1, which leaves existing payload.fold flags untouched.
  // 2. fit() gets a maxScale, so that when the user does expand everything (or
  //    hits 适配视图) the map zooms out no further than actual size.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !md) return
    let mm: Markmap | null = null
    try {
      const { root } = new Transformer().transform(md)
      foldBelowDepth(root as MindNode, planMindDepth(root as MindNode))
      mm = new Markmap(svg, {
        duration: 0,
        maxWidth: 320,
        spacingVertical: 6,
        initialExpandLevel: -1,
      })
      mapRef.current = mm
      void mm.setData(root).then(() => mm?.fit(FIT_MAX_SCALE)).catch(() => { /* keep whatever rendered */ })
      // Refit on resize. This does re-run the capped fit, so a resize after the
      // user zoomed in will re-fit; that is the price of never re-laying out a
      // stale viewport, and 适配视图 is there when they want it on demand.
      const ro = typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => { void mm?.fit(FIT_MAX_SCALE) })
        : null
      ro?.observe(svg)
      return () => {
        ro?.disconnect()
        mm?.destroy()
        if (mapRef.current === mm) mapRef.current = null
      }
    } catch (e) {
      setErr('脑图渲染失败：' + (e as Error).message)
      return () => { mm?.destroy() }
    }
  }, [md])

  const regenerate = useCallback(async () => {
    if (!activeId) return
    setBusy(true)
    try {
      await apiPost('/export/' + encodeURIComponent(activeId))
      onToast('已重新生成 Markdown 与脑图')
      refresh()
    } catch (e) {
      onToast('重新生成失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [activeId, onToast, refresh])

  const bar = h('div', { className: 'kb-mind-bar' },
    docs.length === 0
      ? h('span', { className: 'kb-mind-hint', style: { marginLeft: 0 } }, '还没有可用的文档')
      : h('select', {
        className: 'kb-mind-select',
        value: activeId,
        onChange: (e: any) => setDocId(e.target.value),
      }, docs.map((d) => h('option', { key: d.id, value: d.id }, d.name))),
    active
      ? h('span', { className: 'kb-mind-hint', style: { marginLeft: 0 } }, outlineLabel(active))
      : null,
    active
      ? h('button', { className: 'kb-btn sm', onClick: () => onOpenMd(active) }, 'Markdown 预览')
      : null,
    active
      ? h('a', { className: 'kb-btn sm', style: { textDecoration: 'none' }, href: exportUrl(active.id, 'md', true) }, '下载 .md')
      : null,
    active
      ? h('a', { className: 'kb-btn sm', style: { textDecoration: 'none' }, href: exportUrl(active.id, 'mindmap', true) }, '下载脑图 .md')
      : null,
    active
      ? h('button', { className: 'kb-btn sm', disabled: busy, onClick: () => void regenerate() }, busy ? '生成中…' : '重新生成')
      : null,
    // Explicit refit, because the capped fit() deliberately leaves part of a
    // large tree off-screen — the user needs a way back to "show me the shape".
    h('button', { className: 'kb-btn sm', title: '缩放到当前展开的层级（不会缩到看不清）', onClick: () => void mapRef.current?.fit(FIT_MAX_SCALE) }, '适配视图'),
    loading ? h('span', { className: 'kb-mind-hint', style: { marginLeft: 0 } }, '加载中…') : null,
    h('span', { className: 'kb-mind-hint' }, '滚轮缩放 · 拖拽平移 · 点击圆点折叠'),
  )

  return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
    bar,
    err ? h('div', { className: 'kb-errorbox' }, err) : null,
    docs.length === 0
      ? h('div', { className: 'kb-empty' }, '还没有解析完成的文档。上传并解析文档后，这里会生成由文档大纲 + LLM 摘要/实体构成的知识脑图。')
      : h('div', { style: { flex: 1, minHeight: 0 } },
        h('div', { className: 'kb-mind-wrap' }, h('svg', { className: 'kb-mind-svg', ref: svgRef })),
        !md && !err && !loading ? h('div', { className: 'kb-empty' }, '暂无可显示的脑图内容。') : null,
      ),
    active?.mdFile
      ? h('div', { style: { padding: '6px 16px', borderTop: '.5px solid var(--dsw-alias-border-l2, #2a2a36)' } },
        h('span', { className: 'kb-export-name' }, '已导出：md/' + (active.mdFile || '') + ' · md/' + (active.mindmapFile || '')))
      : null,
  )
}

// ---- Markdown preview ------------------------------------------------------
// Preview of the generated <name>.md: rendered by default (readable) with a
// one-click switch to the raw source, plus the same download the card offers.

function MdOverlay({ doc, onClose }: { doc: ClientDoc; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [raw, setRaw] = useState(false)
  useEffect(() => {
    let alive = true
    setText(null)
    setErr(null)
    apiText('/doc/' + encodeURIComponent(doc.id) + '/md')
      .then((t) => { if (alive) setText(t) })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [doc.id])
  const html = useMemo(() => (text ? renderMarkdownLite(text) : ''), [text])
  const overlayStyle: CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 2147483602, background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.5))',
    display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 24,
  }
  const panelStyle: CSSProperties = {
    width: 'min(860px, 94vw)', height: 'min(86vh, 900px)', background: 'var(--dsw-alias-bg-layer-1, #1e1f23)',
    color: 'var(--dsw-alias-label-primary, #e7e7ea)', borderRadius: 'var(--dsw-radius-lg, 16px)', border: '1px solid var(--dsw-alias-border-l3, #3a3a48)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    boxShadow: 'var(--dsw-shadow-lv2, 0 12px 48px rgba(0,0,0,0.5))',
  }
  return h('div', { style: overlayStyle, onClick: onClose },
    h('div', { style: panelStyle, onClick: (e: any) => e.stopPropagation() },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '.5px solid var(--dsw-alias-border-l2, #2a2a36)' } },
        h('span', { style: { fontWeight: 600, fontSize: 14, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          '📄 ' + (doc.mdFile || doc.name + '.md')),
        h('button', { className: 'kb-btn sm', onClick: () => setRaw((v) => !v) }, raw ? '渲染预览' : '查看源文件'),
        h('a', { className: 'kb-btn sm', style: { textDecoration: 'none' }, href: exportUrl(doc.id, 'md', true) }, '下载'),
        h('button', { className: 'kb-btn sm plain', onClick: onClose }, '✕'),
      ),
      h('div', { style: { flex: 1, overflow: 'auto', padding: '14px 16px' } },
        err ? h('div', { className: 'kb-errorbox', style: { margin: 0 } }, err)
          : text === null ? h('div', { className: 'kb-empty' }, '加载中…')
          : raw ? h('pre', { className: 'kb-md-src' }, text)
          : h('div', { className: 'kb-md', dangerouslySetInnerHTML: { __html: html } }),
      ),
    ),
  )
}

// ---- settings pane ---------------------------------------------------------
// LLM enrichment can be toggled and pointed at any provider route the host llm
// service exposes (workbuddy, deepseek-official, …) plus a model from that
// route's live catalog. Saved settings persist host-side (settings.json) and
// hot-swap the parse pipeline — already-parsed docs keep their data.

interface ProviderOption { id: string; name: string }
interface ModelOption { id: string; name?: string }

function SettingsPane({ refresh }: { refresh: () => void }) {
  const [loaded, setLoaded] = useState(false)
  const [llmAvailable, setLlmAvailable] = useState(true)
  const [enabled, setEnabled] = useState(true)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [maxEnrich, setMaxEnrich] = useState(400)
  const [concurrency, setConcurrency] = useState(4)
  const [saving, setSaving] = useState(false)
  const [backendNote, setBackendNote] = useState<string | null>(null)
  // Access-token settings (mirrors the host's settings.json `apiToken*`).
  const [authEnabled, setAuthEnabled] = useState(true)
  const [authToken, setAuthToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [rotating, setRotating] = useState(false)

  const load = useCallback(async () => {
    try {
      const json = await apiGet<any>('/settings')
      setLlmAvailable(Boolean(json.llmAvailable))
      const s = json.settings ?? {}
      setEnabled(Boolean(s.llmEnabled))
      setProvider(String(s.llmProvider || ''))
      setModel(String(s.llmModel || ''))
      setProviders(json.providers ?? [])
      setModels(json.models ?? [])
      setMaxEnrich(Number(s.maxEnrichChunks ?? 400))
      setConcurrency(Number(s.enrichConcurrency ?? 4))
      setAuthEnabled(s.apiTokenEnabled !== false)
      setAuthToken(String(s.apiToken || ''))
      setBackendNote(json.note ?? null)
      return true
    } catch (e) {
      setLlmAvailable(false)
      setBackendNote('设置读取失败：' + (e as Error).message)
      return false
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Fetch the model catalog of an arbitrary provider without touching the
  // saved settings (preview before switching).
  const previewModels = useCallback(async (p: string) => {
    if (!p) { setModels([]); return }
    try {
      const json = await apiGet<any>('/settings?provider=' + encodeURIComponent(p))
      setModels(json.models ?? [])
    } catch {
      setModels([])
    }
  }, [])

  const onProviderChange = useCallback((p: string) => {
    setProvider(p)
    void previewModels(p)
    setModel('')
  }, [previewModels])

  // Persist everything at once: LLM/enrichment fields plus the access token.
  // `rotate` lets the caller invalidate a leaked token; the host mints a fresh
  // one and returns it in `settings`, which we adopt so this page stays in.
  const persist = useCallback(async (rotate: boolean) => {
    setSaving(true)
    try {
      const json = await apiPostJson('/settings', {
        llmEnabled: enabled,
        llmProvider: provider,
        llmModel: model,
        maxEnrichChunks: Math.max(0, Math.floor(Number(maxEnrich) || 0)),
        enrichConcurrency: Math.min(8, Math.max(1, Math.floor(Number(concurrency) || 4))),
        apiTokenEnabled: authEnabled,
        rotateToken: rotate,
      })
      const s = json?.settings ?? {}
      if (s.apiToken) {
        adoptToken(String(s.apiToken))
        setAuthToken(String(s.apiToken))
      }
      setAuthEnabled(s.apiTokenEnabled !== false)
      setBackendNote(json.note ?? null)
      showToastSafe(json.ok ? '已保存，设置即时生效' : '已保存，但后端未生效：' + (json.note || ''))
      refresh()
      return true
    } catch (e) {
      showToastSafe('保存失败：' + (e as Error).message)
      return false
    } finally {
      setSaving(false)
    }
  }, [enabled, provider, model, maxEnrich, concurrency, authEnabled, refresh])

  const save = useCallback(() => persist(false), [persist])

  const rotateToken = useCallback(async () => {
    setRotating(true)
    try {
      const ok = await persist(true)
      if (ok) showToastSafe('已生成新令牌，旧令牌立即失效')
    } finally {
      setRotating(false)
    }
  }, [persist])

  // Settings fields are laid out label-above-control inside a card; the two
  // style objects below are the only per-control sizing left.
  const selectStyle: CSSProperties = {
    flex: 1, padding: '5px 10px', borderRadius: 'var(--dsw-radius-sm, 8px)',
    border: '1px solid var(--dsw-alias-border-l2, #3a3a48)', background: 'var(--dsw-alias-bg-layer-3, #2a2a36)',
    color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 13, fontFamily: 'inherit',
  }
  const numberStyle: CSSProperties = {
    width: 120, flex: 'none', padding: '5px 10px', borderRadius: 'var(--dsw-radius-sm, 8px)',
    border: '1px solid var(--dsw-alias-border-l2, #3a3a48)', background: 'var(--dsw-alias-bg-layer-3, #2a2a36)',
    color: 'var(--dsw-alias-label-primary, inherit)', fontSize: 13, fontFamily: 'inherit',
  }

  if (!loaded) return h('div', { className: 'kb-empty' }, '加载中…')
  if (!llmAvailable) {
    return h('div', { className: 'kb-set' },
      h('div', { className: 'kb-setcard' },
        h('div', { className: 'kb-setcard-title' }, '⚠ LLM 增强不可用'),
        h('div', { className: 'kb-sethint', style: { fontSize: 12.5, lineHeight: '20px' } },
          '知识库暂未连接到宿主 LLM 服务，因此无法配置 LLM 增强。'),
        backendNote ? h('div', { className: 'kb-warn', style: { fontSize: 12, lineHeight: '18px', marginTop: 8 } }, '⚠ ' + backendNote) : null,
        h('div', { className: 'kb-sethint', style: { marginTop: 8 } },
          '常见原因：插件尚未重新加载（需完全退出并重启客户端）、宿主未挂载 llm 服务插件，或服务注册晚于本插件激活。'),
        h('div', { className: 'kb-set-foot' },
          h('button', { className: 'kb-btn', onClick: () => { void load().then(() => showToastSafe('已重新检测')) } }, '重新检测'),
        ),
      ),
    )
  }

  return h('div', { style: { height: '100%', overflow: 'auto' } },
    h('div', { className: 'kb-set' },
      h('div', { className: 'kb-set-grid' },
        // ---- card 1: which model does the work ----------------------------
        h('div', { className: 'kb-setcard' },
          h('div', { className: 'kb-setcard-title' },
            'LLM 增强',
            h('button', {
              className: 'kb-btn sm' + (enabled ? ' on' : ''),
              style: enabled
                ? { marginLeft: 'auto', color: 'var(--dsw-alias-state-success-primary, #22c55e)', borderColor: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 40%, transparent)' }
                : { marginLeft: 'auto' },
              onClick: () => setEnabled((v) => !v),
            }, enabled ? '已开启' : '已关闭'),
          ),
          h('div', { className: 'kb-setfield' },
            h('div', { className: 'kb-setlabel' }, '模型提供方'),
            h('select', {
              style: selectStyle, value: provider,
              onChange: (e: any) => onProviderChange(e.target.value),
              disabled: !enabled,
            },
              providers.length === 0 ? h('option', { value: provider }, provider || '（无可用 provider）') : null,
              providers.map((p) => h('option', { key: p.id, value: p.id }, p.name ? `${p.name} (${p.id})` : p.id)),
            ),
            h('div', { className: 'kb-sethint' }, '解析文档时用 LLM 抽取摘要 / 实体 / 关联概念'),
          ),
          h('div', { className: 'kb-setfield' },
            h('div', { className: 'kb-setlabel' }, '模型'),
            h('div', { className: 'kb-setcontrol' },
              h('select', {
                style: selectStyle, value: model,
                onChange: (e: any) => setModel(e.target.value),
                disabled: !enabled,
              },
                // The saved model may not be in the catalog (pass-through ids are
                // legal) — keep it selectable rather than silently dropping it.
                model && !models.some((m) => m.id === model)
                  ? h('option', { key: '__current', value: model }, model + '（当前）')
                  : null,
                models.map((m) => h('option', { key: m.id, value: m.id }, m.name ? `${m.name} (${m.id})` : m.id)),
                models.length === 0 && !model ? h('option', { value: '' }, '（该 provider 未列出模型，可手填）') : null,
              ),
              models.length === 0
                ? h('input', {
                  className: 'kb-search', style: { flex: 1, maxWidth: 160 }, placeholder: '手动输入模型 id…',
                  value: model, disabled: !enabled,
                  onChange: (e: any) => setModel(e.target.value),
                })
                : null,
            ),
          ),
        ),
        // ---- card 2: how much, how fast ----------------------------------
        h('div', { className: 'kb-setcard' },
          h('div', { className: 'kb-setcard-title' }, '增强批次与并发'),
          h('div', { className: 'kb-setfield' },
            h('div', { className: 'kb-setlabel' }, '每批增强片段数'),
            h('input', {
              className: 'kb-search', style: numberStyle, type: 'number', min: 0, step: 50,
              value: String(maxEnrich), disabled: !enabled,
              onChange: (e: any) => setMaxEnrich(Math.max(0, Math.floor(Number(e.target.value) || 0))),
            }),
            h('div', { className: 'kb-sethint' },
              '每次 LLM 增强一批处理多少个片段。这不是总量上限：点「增强」之后会自动一批接一批跑，直到全文都写有小结（中途可随时点「停止」，下次接着跑）。数值越大，中途停下来的损失越大。'),
          ),
          h('div', { className: 'kb-setfield' },
            h('div', { className: 'kb-setlabel' }, '并发数'),
            h('input', {
              className: 'kb-search', style: numberStyle, type: 'number', min: 1, max: 8, step: 1,
              value: String(concurrency), disabled: !enabled,
              onChange: (e: any) => setConcurrency(Math.min(8, Math.max(1, Math.floor(Number(e.target.value) || 1)))),
            }),
            h('div', { className: 'kb-sethint' },
              '同时进行的增强请求数（1–8）；越大越快，也越容易触发提供方限流'),
          ),
        ),
        // ---- card 3: access token ------------------------------------------
        h('div', { className: 'kb-setcard' },
          h('div', { className: 'kb-setcard-title' },
            '访问令牌',
            h('button', {
              className: 'kb-btn sm' + (authEnabled ? ' on' : ''),
              style: authEnabled
                ? { marginLeft: 'auto', color: 'var(--dsw-alias-state-success-primary, #22c55e)', borderColor: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 40%, transparent)' }
                : { marginLeft: 'auto' },
              onClick: () => setAuthEnabled((v) => !v),
            }, authEnabled ? '已开启' : '已关闭'),
          ),
          h('div', { className: 'kb-setfield' },
            h('div', { className: 'kb-setlabel' }, '令牌'),
            h('div', { className: 'kb-setcontrol' },
              h('input', {
                className: 'kb-search', style: { flex: 1, minWidth: 0, fontFamily: 'ui-monospace, monospace', fontSize: 12 },
                readOnly: true, value: authToken ? (showToken ? authToken : authToken.slice(0, 6) + '…' + authToken.slice(-4)) : '（未生成）',
                title: authToken,
              }),
              h('button', { className: 'kb-btn plain', onClick: () => setShowToken((v) => !v) }, showToken ? '隐藏' : '显示'),
              h('button', {
                className: 'kb-btn plain', disabled: !authToken,
                onClick: () => {
                  if (!authToken) return
                  try {
                    void navigator.clipboard?.writeText(authToken)
                    showToastSafe('令牌已复制到剪贴板')
                  } catch { showToastSafe('复制失败，请手动选中后复制') }
                },
              }, '复制'),
              h('button', { className: 'kb-btn plain', disabled: saving || rotating, onClick: () => void rotateToken() }, rotating ? '生成中…' : '重新生成'),
            ),
            h('div', { className: 'kb-sethint' },
              '开启后，本机面板会自动带上令牌访问知识库接口；令牌同时以明文保存在 settings.json。担心泄露时点「重新生成」，旧令牌立刻失效（正在打开的页面会自动重连）。'),
          ),
        ),
      ),
      backendNote
        ? h('div', { className: 'kb-warn', style: { fontSize: 12, marginTop: 14, lineHeight: '18px' } }, '⚠ ' + backendNote)
        : null,
      h('div', { className: 'kb-set-foot' },
        h('button', { className: 'kb-btn primary', onClick: () => void save(), disabled: saving }, saving ? '保存中…' : '保存设置'),
        h('button', { className: 'kb-btn plain', onClick: () => { void previewModels(provider) } }, '刷新模型列表'),
      ),
      h('div', { className: 'kb-sethint', style: { marginTop: 10 } },
        '设置保存在本地（settings.json），保存后立即生效，无需重启。文档在上传时只做本地提取（不花钱、几秒完成），LLM 增强由你在文档列表点「增强」或「批量增强」启动，启动后会自动分批跑完全文。'),
    ),
  )
}

// SettingsPane renders outside KnowledgePage so it cannot use the page-level
// toast; fall back to a transient element via a module-level callback that
// KnowledgePage wires up.
let toastBridge: ((msg: string) => void) | null = null
function showToastSafe(msg: string): void {
  if (toastBridge) toastBridge(msg)
}

// Deterministic base layout: docs on an inner circle, entities on concentric
// rings around them, in a fixed 1000x720 logical space. The component then
// self-measures its container and fits/zooms/pans that space — so it can never
// collapse to white.
//
// A StoneOS-sized corpus has ~5300 entities and ~4000 edges. Drawing all of
// them produced a solid green disc: the outer ring held 600 dots ~3px apart and
// every one of them owned several chords. So the canvas deliberately shows a
// degree-ranked slice, spreads it over several rings, and reports in the corner
// exactly how much of the graph that is — a silent truncation would read as
// "this is everything" and mislead.
const LW = 1000
const LH = 720
// Chords drawn at once. Weighted edges are the informative ones; the tail is
// mostly "co-occurs somewhere in the same chunk" noise.
const EDGE_LIMIT = 800
// Only the best-connected entities get a permanent label; 600 labels in a
// 1440px-wide canvas is just noise laid on top of noise.
const LABEL_LIMIT = 40
const RING_MIN = Math.min(LW, LH) * 0.22
const RING_MAX = Math.min(LW, LH) * 0.46
// Arc length one node needs on a ring, in logical px — roughly label height plus
// breathing room.
const RING_GAP = 26
// How many concentric rings the entity slice is spread over. Each ring's own
// circumference bounds how many nodes it can hold legibly, so the ring count
// together with RING_GAP caps how many entities exist at all.
const RING_STEPS = 4

function ringRadius(r: number): number {
  return RING_MIN + ((RING_MAX - RING_MIN) * r) / (RING_STEPS - 1)
}
function ringCapacity(radius: number): number {
  return Math.max(6, Math.floor((2 * Math.PI * radius) / RING_GAP))
}
// Everything the rings can physically hold. Offering a slice larger than this
// would leave entities without a position — the exact silent truncation the
// corner hint is supposed to prevent.
const RING_TOTAL = Array.from({ length: RING_STEPS }, (_, r) => ringCapacity(ringRadius(r))).reduce((a, b) => a + b, 0)
// Entity slices offered by the 实体 button, in order. Each step is a real change
// in what is drawn, and the last one fills every ring.
const ENT_LIMITS = [60, 150, RING_TOTAL]
function GraphCanvas(props: {
  graph: ClientGraph
  onReload: () => void
  focusEntity: string | null
  onFocusEntity: (e: string) => void
  onOpenDoc: (id: string) => void
}) {
  const { graph, onReload, focusEntity, onFocusEntity, onOpenDoc } = props
  // Theme-aware palette (host tokens with dark fallbacks). SVG presentation
  // attributes accept var() so the graph follows light/dark switching.
  const ACCENT = 'var(--dsw-alias-state-business-primary, #4176e6)'
  const GREEN = 'var(--dsw-alias-state-success-primary, #22c55e)'
  const EDGE_DOC = 'var(--dsw-alias-border-l4, #39507f)'
  const EDGE_REL = 'var(--dsw-alias-state-success-tertiary, #4a7d5f)'
  const LABEL = 'var(--dsw-alias-label-secondary, #cfd2dd)'
  const LABEL_DIM = 'var(--dsw-alias-label-caption, #6a6a78)'
  const NODE_STROKE = 'var(--dsw-alias-bg-base, #0c0c12)'
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 800, h: 520 })
  const [view, setView] = useState({ scale: 1, tx: 0, ty: 0 })
  const [hover, setHover] = useState<string | null>(null)
  const [entStep, setEntStep] = useState(0)
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)

  const entLimit = ENT_LIMITS[Math.min(entStep, ENT_LIMITS.length - 1)]
  const docs = graph.nodes.filter((n) => n.kind === 'doc')
  const allEnts = graph.nodes.filter((n) => n.kind === 'entity')
  const cx = LW / 2
  const cy = LH / 2

  // Weighted degree decides the slice: the best-connected entities are the ones
  // worth the pixels. Both endpoints contribute — a chord means the two terms
  // are related, not that the target is the popular one. Ties break on the
  // label so the layout never jitters between two refreshes of the same corpus.
  const degree = new Map<string, number>()
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + e.weight)
    degree.set(e.target, (degree.get(e.target) ?? 0) + e.weight)
  }
  const ranked = allEnts
    .map((n) => ({ n, deg: degree.get(n.id) ?? 0 }))
    .sort((a, b) => (b.deg - a.deg) || a.n.label.localeCompare(b.n.label))
  // Focusing an entity that the current slice would drop would point the user
  // at nothing, so a focused entity is promoted into the slice (evicting the
  // weakest one) instead of silently disappearing.
  const focusedId = focusEntity ? 'e:' + focusEntity.toLowerCase() : null
  const ents = ranked.slice(0, entLimit).map((r) => r.n)
  if (focusedId) {
    const at = ents.findIndex((n) => n.id === focusedId)
    if (at < 0) {
      const incoming = allEnts.find((n) => n.id === focusedId)
      if (incoming) {
        if (ents.length >= entLimit) ents.pop()
        ents.push(incoming)
      }
    }
  }

  const pos = new Map<string, { x: number; y: number }>()
  docs.forEach((n, i) => {
    const a = (i / Math.max(1, docs.length)) * Math.PI * 2 - Math.PI / 2
    pos.set(n.id, { x: cx + Math.cos(a) * RING_MIN * 0.72, y: cy + Math.sin(a) * RING_MIN * 0.72 })
  })
  // Fill rings from the inside out; each ring holds as many nodes as its
  // circumference can space legibly. Odd rings are rotated half a slot so the
  // nodes above each other do not line up into spokes.
  {
    let placed = 0
    for (let r = 0; r < RING_STEPS && placed < ents.length; r += 1) {
      const radius = ringRadius(r)
      const cap = Math.max(6, ringCapacity(radius))
      const slice = ents.slice(placed, placed + cap)
      const offset = -Math.PI / 2 + (r % 2 === 0 ? 0 : Math.PI / Math.max(1, slice.length))
      slice.forEach((n, i) => {
        const a = (i / Math.max(1, slice.length)) * Math.PI * 2 + offset
        pos.set(n.id, { x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius })
      })
      placed += slice.length
    }
  }

  // Only edges inside the visible slice exist as far as the canvas is concerned,
  // and even then only the heaviest ones — 4000 chords is what made the disc.
  // The cap scales with the slice so chord density (edges per entity) stays
  // constant: a 60-entity view that still painted 800 chords was a green haze in
  // the middle of an otherwise readable ring.
  const edgeCap = Math.max(120, Math.round((EDGE_LIMIT * entLimit) / RING_TOTAL))
  const inSlice = graph.edges.filter((e) => pos.has(e.source) && pos.has(e.target))
  const visibleEdges = inSlice.slice().sort((a, b) => b.weight - a.weight).slice(0, edgeCap)
  const edgeLimitHit = inSlice.length > edgeCap
  const entsHidden = allEnts.length - ents.length

  // Fit graph into the container whenever size or graph changes.
  const fit = useCallback(() => {
    const { w, h } = size
    if (!w || !h) return
    const s = Math.min(w / LW, h / LH) * 0.92
    setView({ scale: s, tx: (w - LW * s) / 2, ty: (h - LH * s) / 2 })
  }, [size])
  useLayoutEffect(() => { fit() }, [fit, graph])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => { setSize({ w: el.clientWidth || 800, h: el.clientHeight || 520 }) })
    ro.observe(el)
    setSize({ w: el.clientWidth || 800, h: el.clientHeight || 520 })
    return () => ro.disconnect()
  }, [])

  const active = hover || focusedId
  const neighbors = new Set<string>()
  if (active) {
    neighbors.add(active)
    for (const e of graph.edges) {
      if (e.source === active) neighbors.add(e.target)
      if (e.target === active) neighbors.add(e.source)
    }
  }
  // `ents` is already degree-ranked, so the head of the slice is the set that
  // earned a permanent label. The active node is labelled separately below.
  const labelled = new Set(ents.slice(0, LABEL_LIMIT).map((n) => n.id))

  const onWheel = (e: any) => {
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    const factor = e.deltaY < 0 ? 1.12 : 0.89
    setView((v) => {
      const ns = Math.max(0.2, Math.min(6, v.scale * factor))
      const lx = (px - v.tx) / v.scale
      const ly = (py - v.ty) / v.scale
      return { scale: ns, tx: px - lx * ns, ty: py - ly * ns }
    })
  }
  const onDown = (e: any) => {
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty }
  }
  const onMove = (e: any) => {
    if (!drag.current) return
    const dx = e.clientX - drag.current.x
    const dy = e.clientY - drag.current.y
    setView((v) => ({ ...v, tx: drag.current!.tx + dx, ty: drag.current!.ty + dy }))
  }
  const onUp = () => { drag.current = null }

  const onNodeClick = (n: any) => {
    if (n.kind === 'doc') { if (n.docId) onOpenDoc(n.docId) }
    else onFocusEntity(n.label)
  }

  return h('div', { ref, className: 'kb-graph-wrap' },
    h('svg', {
      className: 'kb-graph-svg' + (drag.current ? ' dragging' : ''),
      width: size.w, height: size.h,
      onWheel, onMouseDown: onDown, onMouseMove: onMove, onMouseUp: onUp, onMouseLeave: onUp,
    },
      h('g', { transform: `translate(${view.tx},${view.ty}) scale(${view.scale})` },
        visibleEdges.map((e, i) => {
          const a = pos.get(e.source)
          const b = pos.get(e.target)
          if (!a || !b) return null
          const lit = active && (e.source === active || e.target === active)
          const dim = active && !lit
          const w = e.kind === 'contains' ? 1 : Math.min(3, 0.6 + e.weight * 0.5)
          return h('line', {
            key: 'e' + i, x1: a.x, y1: a.y, x2: b.x, y2: b.y,
            stroke: e.kind === 'contains' ? EDGE_DOC : EDGE_REL,
            'stroke-width': w, 'stroke-opacity': dim ? 0.1 : (lit ? 0.95 : 0.26),
          })
        }),
        // Iterate what was positioned, not what the server sent: a node without a
        // position has no honest place to draw and must not be faked at 0,0.
        [...docs, ...ents].map((n) => {
          const p = pos.get(n.id)
          if (!p) return null
          const deg = degree.get(n.id) ?? 0
          const r = n.kind === 'doc' ? 6 + Math.min(8, n.weight) : 3 + Math.min(6, deg)
          const fill = n.kind === 'doc' ? ACCENT : GREEN
          const isActive = active && n.id === active
          const dim = active && !neighbors.has(n.id)
          return h('g', {
            key: n.id, style: { cursor: 'pointer' },
            onMouseEnter: () => setHover(n.id), onMouseLeave: () => setHover(null),
            onClick: () => onNodeClick(n),
          },
            h('circle', { cx: p.x, cy: p.y, r, fill, 'fill-opacity': dim ? 0.25 : 0.9, stroke: isActive ? LABEL : NODE_STROKE, 'stroke-width': isActive ? 2 : 1 }),
            (n.kind === 'doc' || labelled.has(n.id) || isActive)
              ? h('text', { x: p.x, y: p.y - r - 3, 'text-anchor': 'middle', fill: dim ? LABEL_DIM : LABEL, 'font-size': n.kind === 'doc' ? 11 : 9 }, n.label.length > 14 ? n.label.slice(0, 13) + '…' : n.label)
              : null,
          )
        }),
      ),
    ),
    h('div', { className: 'kb-legend' },
      h('span', null, h('i', { style: { background: ACCENT } }), '文档'),
      h('span', null, h('i', { style: { background: GREEN } }), '实体'),
      h('button', {
        className: 'kb-btn plain', style: { fontSize: 11, padding: '0 6px', border: 'none' },
        title: `切换实体数量：${ENT_LIMITS.join(' / ')}`,
        onClick: () => setEntStep((s) => (s + 1) % ENT_LIMITS.length),
      }, `实体 ${entLimit}`),
      h('button', { className: 'kb-btn plain', style: { fontSize: 11, padding: '0 6px', border: 'none' }, onClick: fit }, '适配'),
      h('button', { className: 'kb-btn plain', style: { fontSize: 11, padding: '0 6px', border: 'none' }, onClick: onReload }, '刷新'),
    ),
    h('div', { className: 'kb-graph-hint', style: { position: 'absolute', right: 10, top: 10 } },
      `显示 ${docs.length + ents.length}/${graph.nodes.length} 节点 · ${visibleEdges.length}/${graph.edges.length} 关系 · 滚轮缩放/拖拽平移`,
      (entsHidden > 0 || edgeLimitHit)
        ? h('div', { style: { marginTop: 2, color: 'var(--dsw-alias-state-warning-primary, #d99a2b)' } },
            `实体/关系已截断：按度数取前 ${entLimit} 实体${entsHidden > 0 ? `（隐藏 ${entsHidden}）` : ''}${edgeLimitHit ? `，边按权重取前 ${edgeCap}` : ''}`)
        : null),
  )
}

function DetailOverlay(props: {
  detail: { doc: ClientDoc; chunks: ClientChunk[] }
  onClose: () => void
  onDelete: () => void
  onFocusEntity: (e: string) => void
  onOpenMd: (d: ClientDoc) => void
}) {
  const { detail, onClose, onDelete, onFocusEntity, onOpenMd } = props
  const { doc, chunks } = detail
  const overlayStyle: CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 2147483601, background: 'var(--dsw-alias-bg-mask-1, rgba(0,0,0,0.5))',
    display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 24,
  }
  const panelStyle: CSSProperties = {
    width: 'min(900px, 94vw)', height: 'min(86vh, 900px)', background: 'var(--dsw-alias-bg-layer-1, #1e1f23)',
    color: 'var(--dsw-alias-label-primary, #e7e7ea)', borderRadius: 'var(--dsw-radius-lg, 16px)', border: '1px solid var(--dsw-alias-border-l3, #3a3a48)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    boxShadow: 'var(--dsw-shadow-lv2, 0 12px 48px rgba(0,0,0,0.5))',
  }
  return h('div', { style: overlayStyle, onClick: onClose },
    h('div', { style: panelStyle, onClick: (e: any) => e.stopPropagation() },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '14px 16px', borderBottom: '.5px solid var(--dsw-alias-border-l2, #2a2a36)' } },
        h('span', { style: { fontWeight: 600, fontSize: 14, flex: 1 } }, '解析结果 · ' + doc.name),
        doc.chunkCount > 0
          ? h('button', { className: 'kb-btn sm', onClick: () => onOpenMd(doc) }, 'Markdown')
          : null,
        h('button', { className: 'kb-btn sm danger', onClick: onDelete }, '删除'),
        h('button', { className: 'kb-btn sm plain', onClick: onClose }, '✕'),
      ),
      h('div', { style: { flex: 1, overflow: 'auto', padding: '14px 16px' } },
        doc.summary ? h('div', { className: 'kb-doc-meta', style: { marginBottom: 8 } }, '摘要：' + doc.summary) : null,
        h('div', { className: 'kb-statusline' },
          h('span', null, `状态 ${statusLabel(doc.status)}`),
          h('span', null, `${doc.chunkCount} 片段`),
          h('span', null, `${doc.entityCount} 实体`),
        ),
        chunks.length === 0 ? h('div', { className: 'kb-empty' }, doc.status === 'done' ? '无内容片段' : '解析尚未完成或失败') :
          chunks.map((c) =>
            h(ChunkView, { key: c.id, chunk: c, onFocusEntity }),
          ),
      ),
    ),
  )
}

function badgeClass(s: string): string {
  if (s === 'done') return 'done'
  if (s === 'error') return 'error'
  if (s === 'cancelled') return 'error'
  // Not a failure and not running: it is waiting for the user to buy LLM
  // summaries. It gets the neutral badge so it does not read as a stalled job.
  if (s === 'extracted') return 'ready'
  return 'busy'
}

// Renders one parsed chunk. The stored text is already bounded by the host, but
// as a defense-in-depth we never paint an unbounded string into the DOM — a
// multi-MB chunk would otherwise crash the renderer.
const CHUNK_DISPLAY_CAP = 3000
function ChunkView({ chunk, onFocusEntity }: { chunk: ClientChunk; onFocusEntity: (e: string) => void }): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const full = chunk.text ?? ''
  const tooLong = full.length > CHUNK_DISPLAY_CAP
  const shown = expanded || !tooLong ? full : full.slice(0, CHUNK_DISPLAY_CAP) + '…'
  return h('div', { className: 'kb-chunk' },
    h('div', { className: 'kb-chunk-title' }, `${chunk.index + 1}. ${chunk.title}`),
    chunk.summary ? h('div', { className: 'kb-doc-meta', style: { fontStyle: 'italic' } }, '摘要：' + chunk.summary) : null,
    h('div', { className: 'kb-chunk-text' }, shown),
    tooLong
      ? h('button', { className: 'kb-btn sm plain', style: { marginTop: 4 }, onClick: () => setExpanded((v) => !v) }, expanded ? '收起' : '展开全文')
      : null,
    chunk.entities.length ? h('div', null, chunk.entities.map((e) => h('span', { className: 'kb-pill entity', title: '聚焦该实体', onClick: () => onFocusEntity(e) }, e))) : null,
    chunk.links.length ? h('div', { style: { marginTop: 4 } }, h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-caption, #9a9aa6)' } }, '关联：'), chunk.links.map((l) => h('span', { className: 'kb-pill link' }, l))) : null,
  )
}
function statusLabel(s: string): string {
  return (
    {
      queued: '排队中',
      extracting: '提取中',
      parsing: '解析中',
      enriching: '增强中',
      indexing: '建库中',
      // `extracted` is the resting state between the two jobs: chunks, mind map
      // and index all exist, but no LLM call has been spent yet. Labelling it
      // 「已完成」 would overstate it, and 「解析中」 would understate it.
      extracted: '待增强',
      done: '已完成',
      error: '失败',
      cancelled: '已停止',
    } as Record<string, string>
  )[s] ?? s
}
function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

// ---- panel icon + page -----------------------------------------------------

/** The sidebar glyph — the shell renders it inside its own row button. */
function KnowledgeIcon({ size }: { size?: number }): ReactElement {
  return h('span', {
    style: { fontSize: size ? Math.round(size * 0.95) : 18, lineHeight: 1, display: 'inline-flex' },
  }, '📚')
}

export const name = 'dsh-llm-wiki-knowledge-client'
export const inject = ['slots']

export function apply(ctx: { slots: any; get?: (name: string) => any }): void {
  try {
    injectStyles()
    // Central page, keyed by the panel id — mirrors 自动化任务's `main` entry.
    // `onBack` returns to the Conversation, the way 自动化任务's page offers its
    // own in-page action; an absent layout service just hides the button.
    ctx.slots.inject('main', () =>
      ctx.slots.register(
        {
          name: 'main',
          key: PANEL_ID,
          inject: () => ({
            onBack: () => {
              try {
                ctx.get?.('layout')?.selectPanel(null)
              } catch {
                /* layout unavailable — the sidebar icon still switches panels */
              }
            },
          }),
        },
        KnowledgePage,
      ),
    )
    // Sidebar icon row; order 20 puts it right after 自动化任务 (order 10).
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: '知识库' },
        KnowledgeIcon,
      ),
    )
  } catch (error) {
    console.error('[dsh-llm-wiki-knowledge] client failed to load:', error)
  }
}
