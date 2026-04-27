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
import { TOOLS, findTool } from './tools.ts'

interface Env {
  BURSARIUM_API_URL: string
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
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const tool = findTool(toolName)
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
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
// Not implementing fully (no streaming needed), just respond with 405.
app.get('/sse', (c) =>
  c.text('SSE transport deprecated. Use Streamable HTTP at POST /', 405)
)

export default app
