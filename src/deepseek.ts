// Optional DeepSeek enrichment.
//
// When a DeepSeek API key is configured in the plugin row, the host half calls
// the chat completions endpoint to upgrade each chunk with a concise summary,
// better entities, and cross-concept relations. The call is best-effort: any
// failure falls back to the local extraction so parsing never hard-fails.

export interface DeepSeekConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export interface ChunkEnrichment {
  summary: string
  entities: string[]
  relations: string[]
}

const SYSTEM = [
  'You are a knowledge-base parser. Given a section of a document, return strict JSON only.',
  'Schema: { "summary": string (one sentence, the section gist),',
  '  "entities": string[] (2-8 key concepts/terms in the original language),',
  '  "relations": string[] (0-6 related concepts that this section also touches, short phrases) }.',
  'Output ONLY the JSON object, no markdown fences.',
].join(' ')

export async function enrichChunk(
  cfg: DeepSeekConfig,
  title: string,
  text: string,
  signal?: AbortSignal,
): Promise<ChunkEnrichment | undefined> {
  if (!cfg.apiKey) return undefined
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Section title: ${title}\n\nSection text:\n${text.slice(0, 4000)}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  }
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(60_000),
    })
    if (!res.ok) return undefined
    const json = (await res.json()) as any
    const content: string = json?.choices?.[0]?.message?.content ?? ''
    return parseEnrichment(content)
  } catch {
    return undefined
  }
}

function parseEnrichment(content: string): ChunkEnrichment | undefined {
  const cleaned = content
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
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
