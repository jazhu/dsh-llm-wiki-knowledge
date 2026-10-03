// DSH host LLM backend for chunk enrichment.
//
// Instead of calling api.deepseek.com directly with a user-supplied API key,
// this backend routes enrichment through the DSH host's own `llm` service
// (provider-neutral, adapter-mounted). This lets the KB use the same model
// the DSH conversation itself uses — no separate key management.
//
// Contract (from @deepseek-ai/dsh-llm 0.2.0-rc.2, extracted from the host
// asar into _tools/):
//   ctx.llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>
//   GenerateOptions = { provider, model, messages, temperature?, maxTokens?, signal? }
//   StreamChunk: text-delta accumulates visible text; terminal `finish` chunk
//   with reason.kind 'error'|'aborted' carries failure{code,message}.

export interface DshLlmRuntime {
  stream(options: DshLlmGenerateOptions): AsyncIterable<DshLlmStreamChunk>
  listProviders?(): { id: string; name: string }[]
  listModels?(provider: string): Promise<{ id: string; name?: string }[]>
}

export interface DshLlmGenerateOptions {
  provider: string
  model: string
  messages: { role: string; content: { type: 'text'; text: string }[] }[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface DshLlmStreamChunk {
  type: 'block-start' | 'text-delta' | 'reasoning-delta' | 'tool-call-delta' | 'block-end' | 'usage' | 'finish'
  index?: number
  text?: string
  reason?: { kind: 'stop' | 'max-tokens' | 'error' | 'aborted'; failure?: { code?: string; message?: string } }
}

export interface DshLlmConfig {
  /** Provider route registered in the host, e.g. 'deepseek-official'. */
  provider: string
  /** Model id (passed through to the wire, need not be in the catalog). */
  model: string
}

export const DSH_LLM_DEFAULTS = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  maxTokens: 1024,
  temperature: 0.2,
}

/**
 * Resolve which registered provider route to use. Prefers `preferred`; falls
 * back to the first registered route when it is not registered. Returns
 * undefined when no provider is available at all.
 */
export function pickProvider(
  runtime: DshLlmRuntime,
  preferred?: string,
): { provider: string; note?: string } | undefined {
  let providers: { id: string }[] = []
  try {
    providers = runtime.listProviders?.() ?? []
  } catch {
    return undefined
  }
  if (providers.length === 0) return undefined
  const ids = providers.map((p) => p.id)
  if (preferred && ids.includes(preferred)) return { provider: preferred }
  if (preferred) {
    return { provider: ids[0], note: `provider "${preferred}" not registered; using "${ids[0]}"` }
  }
  return { provider: ids[0] }
}

/**
 * Parse the model's JSON answer into a ChunkEnrichment. Tolerates markdown
 * fences; any shape mismatch yields undefined (caller falls back to local
 * extraction).
 */
export function parseEnrichmentJson(text: string): { summary: string; entities: string[]; relations: string[] } | undefined {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  try {
    const obj = JSON.parse(cleaned)
    return {
      summary: typeof obj.summary === 'string' ? obj.summary : '',
      entities: Array.isArray(obj.entities) ? obj.entities.filter((e: unknown) => typeof e === 'string') : [],
      relations: Array.isArray(obj.relations) ? obj.relations.filter((e: unknown) => typeof e === 'string') : [],
    }
  } catch {
    return undefined
  }
}

/**
 * One enrichment call through the host LLM service. Mirrors `enrichChunk`'s
 * contract: resolves with ChunkEnrichment, or undefined on any failure
 * (best-effort, never throws).
 */
export async function enrichChunkViaDsh(
  runtime: DshLlmRuntime,
  cfg: DshLlmConfig,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
): Promise<{ summary: string; entities: string[]; relations: string[] } | undefined> {
  try {
    // `stream()` returns an async iterable for an in-process service; a remote
    // (typert) facade can hand back a promise *for* one, so normalise with an
    // await before iterating. `Promise.resolve` is a no-op for the iterable.
    const stream = await Promise.resolve(
      runtime.stream({
        provider: cfg.provider,
        model: cfg.model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: systemPrompt }] },
          { role: 'user', content: [{ type: 'text', text: userPrompt }] },
        ],
        temperature: DSH_LLM_DEFAULTS.temperature,
        maxTokens: DSH_LLM_DEFAULTS.maxTokens,
        signal: signal ?? AbortSignal.timeout(120_000),
      }),
    )
    let text = ''
    let finish: DshLlmStreamChunk['reason'] | undefined
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
      }
      if (chunk.type === 'finish') {
        finish = chunk.reason
        break
      }
      // 'usage', 'block-start' etc. are ignored — we only need visible text.
    }
    if (finish && finish.kind !== 'stop' && finish.kind !== 'max-tokens') return undefined
    if (!text.trim()) return undefined
    return parseEnrichmentJson(text)
  } catch {
    return undefined
  }
}
