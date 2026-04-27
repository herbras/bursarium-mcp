// Bursarium MCP server.
//
// Implements Model Context Protocol (https://modelcontextprotocol.io)
// over Streamable HTTP — a single endpoint that accepts JSON-RPC POSTs
// and responds with JSON (or SSE for streaming, which we don't need
// since all our tools are sync request/response).
//
// Stateless: every request is independent. Tools wrap REST endpoints on
// bursarium.sarbeh.com and return TOON (token-efficient text format)
// to whichever agent is calling.
//
// Endpoints:
//   POST /        Streamable HTTP (MCP 2025-03 spec)
//   GET  /        Resource tree (humans / discovery)
//   GET  /sse     SSE transport (legacy, optional)
//   GET  /health  Liveness

import { Hono } from 'hono'
import { TOOLS, coerceArgs, findTool } from './tools.ts'

interface Env {
  BURSARIUM_API_URL: string
  // biome-ignore lint/suspicious/noExplicitAny: workers-ai binding type from cf runtime
  AI: any
}

const app = new Hono<{ Bindings: Env }>()

// CORS for browser-based agents
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*')
  c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  c.header('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Mcp-Protocol-Version')
  c.header('Access-Control-Expose-Headers', 'Mcp-Session-Id')
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

const PROTOCOL_VERSION = '2025-03-26'
const SERVER_INFO = {
  name: 'bursarium-mcp',
  version: '0.1.0',
  description: 'Indonesian Stock Exchange (IDX) and KSEI ownership data, served as MCP tools.'
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string | null
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcSuccess {
  jsonrpc: '2.0'
  id: number | string | null
  result: unknown
}

interface JsonRpcError {
  jsonrpc: '2.0'
  id: number | string | null
  error: { code: number; message: string; data?: unknown }
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError

function ok(id: JsonRpcRequest['id'], result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}
function err(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcError {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function callTool(
  env: Env,
  toolName: string,
  rawArgs: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const tool = findTool(toolName)
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      isError: true
    }
  }

  const args = coerceArgs(tool, rawArgs)

  // Presentation tools — no API call, echo args.
  if (tool.presentation) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ rendered: true, kind: toolName, args })
        }
      ]
    }
  }

  if (!tool.build) {
    return {
      content: [{ type: 'text', text: `Tool ${toolName} has no build()` }],
      isError: true
    }
  }
  const { url, postProcess } = tool.build(args)
  const fullUrl = `${env.BURSARIUM_API_URL}${url}`

  let response: Response
  try {
    response = await fetch(fullUrl, {
      headers: {
        // Always request TOON — saves ~40% tokens for the agent.
        Accept: 'text/toon',
        'User-Agent': 'bursarium-mcp/0.1 (claude-mcp; +https://mcp.sarbeh.com)'
      }
    })
  } catch (e) {
    return {
      content: [{ type: 'text', text: `Network error calling ${url}: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true
    }
  }

  if (!response.ok) {
    const body = await response.text()
    return {
      content: [
        { type: 'text', text: `Bursarium API error ${response.status} for ${url}: ${body.slice(0, 500)}` }
      ],
      isError: true
    }
  }

  const text = await response.text()
  const contentType = response.headers.get('content-type') ?? ''

  if (postProcess) {
    // Post-processing requires JSON; refetch as JSON for that case.
    let parsed: unknown
    try {
      // If we already got TOON, refetch as JSON.
      if (!contentType.includes('json')) {
        const jsonRes = await fetch(fullUrl, {
          headers: {
            Accept: 'application/json',
            'User-Agent': 'bursarium-mcp/0.1'
          }
        })
        parsed = await jsonRes.json()
      } else {
        parsed = JSON.parse(text)
      }
    } catch {
      return {
        content: [{ type: 'text', text: `Failed to parse response for post-processing` }],
        isError: true
      }
    }
    const filtered = postProcess(parsed)
    return {
      content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }]
    }
  }

  return {
    content: [{ type: 'text', text }]
  }
}

async function handleRequest(env: Env, body: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const { id, method, params = {} } = body

  switch (method) {
    case 'initialize': {
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {}
        },
        serverInfo: SERVER_INFO,
        instructions: `Bursarium provides Indonesian Stock Exchange (IDX) data and KSEI ownership intelligence.

Use these tools to answer questions about:
- Indonesian stocks (BBCA, TLKM, ASII, etc.) — try get_ticker or get_ownership
- Market indices (IHSG/COMPOSITE, LQ45, IDX30) — get_indices, get_index_summary
- Foreign ownership trends — get_top_foreign_owned, get_foreign_flow
- Top movers — get_top_movers with direction=gainer or loser
- Fundamental screening — get_stock_screener, get_financial_ratio
- Sector performance — get_sectoral_movement
- Dividend calendar — get_dividend_calendar

Data refresh: hourly during market hours (Mon-Fri 09:00-16:00 WIB), full close at 18:00 WIB daily, KSEI ownership monthly.

When citing data in answers, credit IDX (idx.co.id) for trading data and KSEI (ksei.co.id) for ownership data.`
      })
    }

    case 'notifications/initialized':
    case 'initialized': {
      // Notification — no response.
      return null
    }

    case 'tools/list': {
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema
        }))
      })
    }

    case 'tools/call': {
      const name = params.name as string | undefined
      const args = (params.arguments as Record<string, unknown>) ?? {}
      if (!name) {
        return err(id, -32602, 'tools/call requires params.name')
      }
      try {
        const result = await callTool(env, name, args)
        return ok(id, result)
      } catch (e) {
        return err(id, -32603, e instanceof Error ? e.message : String(e))
      }
    }

    case 'ping': {
      return ok(id, {})
    }

    default:
      return err(id, -32601, `Method not found: ${method}`)
  }
}

// ---- HTTP routes ----

app.get('/', (c) =>
  c.json({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
    description: SERVER_INFO.description,
    protocol: PROTOCOL_VERSION,
    docs: 'https://app.sarbeh.com/llms.txt',
    transport: {
      streamableHttp: { url: 'https://mcp.sarbeh.com/', method: 'POST' }
    },
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
    install: {
      claudeDesktop: {
        path: '~/Library/Application Support/Claude/claude_desktop_config.json',
        config: {
          mcpServers: {
            bursarium: {
              url: 'https://mcp.sarbeh.com',
              transport: 'http'
            }
          }
        }
      },
      claudeCode: 'claude mcp add bursarium --transport http https://mcp.sarbeh.com'
    }
  })
)

app.get('/health', (c) => c.json({ status: 'ok', protocol: PROTOCOL_VERSION }))

// Streamable HTTP transport — single endpoint for JSON-RPC POSTs.
app.post('/', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
  }

  // Batch?
  if (Array.isArray(body)) {
    const responses = await Promise.all(
      body.map((msg) => handleRequest(c.env, msg as JsonRpcRequest))
    )
    const filtered = responses.filter((r): r is JsonRpcResponse => r !== null)
    if (filtered.length === 0) return c.body(null, 204)
    return c.json(filtered)
  }

  const response = await handleRequest(c.env, body as JsonRpcRequest)
  if (response === null) return c.body(null, 204)
  return c.json(response)
})

// Legacy SSE transport — accept GET for compat with older clients.
app.get('/sse', (c) =>
  c.text('SSE transport deprecated. Use Streamable HTTP at POST /', 405)
)

// ----------------------------------------------------------------------------
// AI Q&A endpoint — accepts a natural-language question, runs Workers AI
// (llama-3.3-70b) with our tool definitions, executes any tool calls against
// api.sarbeh.com, returns the model's final answer + trace of tool calls.
// ----------------------------------------------------------------------------

function buildSystemPrompt(now: Date): string {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1
  const monthNames = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember']
  const prevM = m === 1 ? 12 : m - 1
  const prevY = m === 1 ? y - 1 : y
  return `Kamu adalah asisten data Bursa Efek Indonesia (IDX) untuk Bursarium.

KONTEKS WAKTU (gunakan untuk resolusi pertanyaan relatif):
- Hari ini: ${now.toISOString().slice(0,10)} (${monthNames[m-1]} ${y})
- "bulan ini" = year=${y}, month=${m}
- "bulan lalu" = year=${prevY}, month=${prevM}
- "tahun ini" = ${y}
JANGAN PERNAH menebak tanggal lain. Kalau pengguna tidak menyebut bulan/tahun, pakai yang di atas.

Tugas: jawab pertanyaan tentang saham IDX, indeks, sektor, kepemilikan asing, dan fundamental, MENGGUNAKAN data dari tools. Jangan jawab dari pengetahuan umum.

Tools dibagi dua jenis:

A. DATA tools — fetch dari Bursarium API. Panggil dulu untuk dapat angka.
   search_emiten, get_ticker, get_ownership, get_ownership_history,
   get_top_foreign_owned, get_foreign_flow, get_top_movers, get_indices,
   get_index_summary, get_sectoral_movement, get_dividend_calendar,
   get_financial_ratio, get_stock_screener, list_snapshots, list_endpoints.

B. PRESENTATION tools — render visualisasi inline. Panggil SETELAH dapat data.
   - present_stat       — angka headline (1 KPI)
   - present_chart_line — time series (foreign% bulanan, IHSG harian)
   - present_chart_bar  — ranking horizontal (top gainer, top foreign)
   - present_split      — komposisi 100% (lokal vs asing)
   - present_compare    — side-by-side dua entitas
   - present_table      — tabel terstruktur

Aturan KETAT:
1. Selalu panggil DATA tool dulu untuk pertanyaan dengan angka spesifik.
2. JANGAN panggil tool yang sama 2x dengan args sama — datanya sudah ada di context.
3. Kalau hasil tool KOSONG (data: [] atau "data[0]:"), katakan TERANG-TERANGAN:
   "Data untuk periode ini belum tersedia di vault Bursarium." JANGAN MENGARANG
   nama sektor, ticker, atau angka. Lebih baik bilang tidak tahu.
4. Setelah dapat data REAL (bukan kosong), pilih 1 presentation tool yang cocok:
   - 1 angka penting → present_stat
   - time series → present_chart_line
   - ranking/list → present_chart_bar
   - komposisi → present_split
   - perbandingan 2 entitas → present_compare
5. Maksimum 2 presentation tool per jawaban.
6. Tutup dengan ringkasan teks 1-3 kalimat Bahasa Indonesia.
7. Sebutkan sumber: "(sumber: KSEI ${monthNames[m-1]} ${y})" atau "(sumber: IDX, ${monthNames[m-1]} ${y})".
8. Ticker UPPERCASE (BBCA, TLKM).
9. Refresh: hourly market hours, daily 18:00 WIB, monthly KSEI.`
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
  name?: string
}

async function runTool(env: Env, name: string, rawArgs: Record<string, unknown>): Promise<string> {
  const tool = findTool(name)
  if (!tool) return `Error: unknown tool ${name}`
  const args = coerceArgs(tool, rawArgs)
  if (tool.presentation) {
    return JSON.stringify({ rendered: true, kind: name, args })
  }
  if (!tool.build) return `Error: tool ${name} has no build()`
  const { url, postProcess } = tool.build(args)
  try {
    const res = await fetch(`${env.BURSARIUM_API_URL}${url}`, {
      headers: {
        Accept: postProcess ? 'application/json' : 'text/toon',
        'User-Agent': 'bursarium-mcp-ai/0.1'
      }
    })
    if (!res.ok) {
      return `Error ${res.status}: ${(await res.text()).slice(0, 300)}`
    }
    const text = await res.text()
    if (postProcess) {
      try {
        return JSON.stringify(postProcess(JSON.parse(text))).slice(0, 4000)
      } catch {
        return text.slice(0, 4000)
      }
    }
    return text.slice(0, 4000)
  } catch (err) {
    return `Network error: ${err instanceof Error ? err.message : String(err)}`
  }
}

app.post('/ask', async (c) => {
  let body: { question?: string; history?: ChatMessage[] }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid JSON' }, 400)
  }
  if (!body.question || typeof body.question !== 'string') {
    return c.json({ error: 'question (string) required' }, 400)
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(new Date()) },
    ...(body.history ?? []).slice(-8),
    { role: 'user', content: body.question }
  ]

  const traces: { tool: string; args: unknown; resultPreview: string }[] = []
  const MAX_ITERS = 4
  let presentationCallCount = 0
  let dataCallCount = 0
  const calledDataTools = new Set<string>()
  // Fingerprint of every (toolName + args) pair we've already executed.
  // Used to short-circuit identical repeat calls without burning quota.
  const calledFingerprints = new Set<string>()

  for (let i = 0; i < MAX_ITERS; i++) {
    // Tool availability schedule:
    //   iter 0: data tools only — force the model to fetch first
    //   iter 1..MAX-2: full toolbox unless quotas hit
    //   iter MAX-1: no tools — force final text answer
    let tools:
      | { type: 'function'; function: { name: string; description: string; parameters: unknown } }[]
      | undefined
    if (i === MAX_ITERS - 1) {
      tools = undefined // no tools → model must respond with text
    } else {
      tools = TOOLS.filter((t) => {
        if (i === 0 && t.presentation) return false
        if (presentationCallCount >= 2 && t.presentation) return false
        // Avoid calling the same data tool twice with same args spamming.
        if (!t.presentation && calledDataTools.has(t.name) && dataCallCount >= 2) return false
        return true
      }).map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema
        }
      }))
    }

    let aiResp: { response?: string; tool_calls?: ChatMessage['tool_calls'] }
    try {
      aiResp = await c.env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
        messages,
        ...(tools ? { tools } : {}),
        max_tokens: 1024,
        temperature: 0.3
      })
    } catch (err) {
      return c.json(
        {
          answer: `Maaf, model AI gagal merespons: ${err instanceof Error ? err.message : String(err)}`,
          traces
        },
        500
      )
    }

    // Workers AI Llama 3.3 returns tool_calls in two possible shapes:
    //   A. OpenAI:  [{ id, type:'function', function:{ name, arguments } }]
    //   B. Native:  [{ name, arguments }]
    // Normalize to A.
    // biome-ignore lint/suspicious/noExplicitAny: dual-shape narrowing
    const rawCalls = (aiResp as any).tool_calls as any[] | undefined
    if (rawCalls && rawCalls.length > 0) {
      const normalized = rawCalls.map((c: any, i: number) => {
        if (c.function) return c // already shape A
        return {
          id: c.id ?? `call_${i}`,
          type: 'function' as const,
          function: {
            name: c.name as string,
            arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {})
          }
        }
      })
      messages.push({ role: 'assistant', content: '', tool_calls: normalized })
      for (const tc of normalized) {
        let args: Record<string, unknown> = {}
        try {
          args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : (tc.function.arguments as Record<string, unknown>)
        } catch {
          args = {}
        }
        // Llama sometimes serializes nested arrays/objects as JSON strings.
        // Re-parse top-level string fields that look like JSON.
        for (const k of Object.keys(args)) {
          const v = args[k]
          if (typeof v === 'string' && (v.startsWith('[') || v.startsWith('{'))) {
            try {
              args[k] = JSON.parse(v)
            } catch {
              /* leave as-is */
            }
          }
        }
        if (tc.function.name.startsWith('present_')) {
          presentationCallCount++
        } else {
          dataCallCount++
          calledDataTools.add(tc.function.name)
        }
        const tool = findTool(tc.function.name)
        const coerced = tool ? coerceArgs(tool, args) : args
        // Dedup identical calls — model often spam-calls the same tool twice.
        const fp = `${tc.function.name}:${JSON.stringify(coerced)}`
        let result: string
        if (calledFingerprints.has(fp)) {
          result = `Note: this exact call (${tc.function.name} with same args) already ran in this conversation. Re-using prior result. Synthesize an answer from the previous tool output instead of calling again.`
        } else {
          calledFingerprints.add(fp)
          result = await runTool(c.env, tc.function.name, coerced)
        }
        traces.push({ tool: tc.function.name, args: coerced, resultPreview: result.slice(0, 500) })
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: result
        })
      }
      continue
    }

    return c.json({
      answer: aiResp.response ?? '(empty response)',
      traces,
      iterations: i + 1
    })
  }

  return c.json({
    answer:
      'Maaf, saya tidak bisa selesaikan pertanyaan ini dalam batas iterasi. Coba pecah jadi pertanyaan yang lebih spesifik.',
    traces,
    iterations: MAX_ITERS
  })
})

export default app
