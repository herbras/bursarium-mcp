// Tool definitions for the Bursarium MCP server.
// Each tool wraps a Bursarium REST endpoint with a typed JSON-Schema input.
// We return responses as TOON for token efficiency (40% savings vs JSON).

export interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  /** URL builder + optional response filter. */
  build: (args: Record<string, unknown>) => { url: string; postProcess?: (data: unknown) => unknown }
}

const optionalLimit = {
  limit: {
    type: 'number',
    description: 'Maximum rows to return (1-500, default 50).',
    minimum: 1,
    maximum: 500
  }
} as const
const optionalOffset = {
  offset: { type: 'number', description: 'Pagination offset, default 0.', minimum: 0 }
} as const
const yearMonth = {
  year: { type: 'number', description: 'Calendar year, e.g. 2026.', minimum: 2020, maximum: 2030 },
  month: { type: 'number', description: 'Calendar month, 1-12.', minimum: 1, maximum: 12 }
} as const
const dateYmd = {
  date: {
    type: 'string',
    description: 'Date in YYYYMMDD format, e.g. 20260224.',
    pattern: '^\\d{8}$'
  }
} as const

export const TOOLS: ToolDef[] = [
  {
    name: 'search_emiten',
    description:
      'Search listed Indonesian companies by ticker code or company name. Returns a list of matches. Use this when the user mentions a stock by name and you need to confirm the ticker.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search term: ticker code (BBCA, TLKM) or company name (Bank Central, Telkom).'
        },
        ...optionalLimit
      },
      required: ['query']
    },
    build: (args) => {
      // Bursarium has no fuzzy search endpoint; return all companies and let
      // the caller filter. With ~958 entries this is fine; cache hits keep
      // it cheap. We expose the query to the client via post-process.
      const limit = (args.limit as number) ?? 1000
      return {
        url: `/companies?limit=${limit}&total=1`,
        postProcess: (data: unknown) => {
          const q = String(args.query ?? '').toLowerCase()
          if (!q) return data
          const env = data as { data: { code: string; name: string }[]; meta: unknown }
          return {
            data: env.data.filter(
              (r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
            ),
            meta: env.meta
          }
        }
      }
    }
  },

  {
    name: 'get_ticker',
    description:
      'Get full details for a single listed company including company profile, listing date, board, and latest KSEI ownership snapshot. Use when the user asks "tell me about BBCA".',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Ticker code, e.g. BBCA. Case-insensitive.'
        }
      },
      required: ['code']
    },
    build: (args) => ({
      url: `/companies/${String(args.code).toUpperCase()}`
    })
  },

  {
    name: 'get_ownership',
    description:
      'Get the latest KSEI shareholder composition for a ticker — broken down by 9 local + 9 foreign investor types (individual, corporate, pension, insurance, mutual fund, securities, foundation, others). Use when the user asks "who owns BBCA?" or about foreign ownership %.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Ticker code, e.g. BBCA.' }
      },
      required: ['code']
    },
    build: (args) => ({
      url: `/ksei/ownership/${String(args.code).toUpperCase()}`
    })
  },

  {
    name: 'get_ownership_history',
    description:
      'Get historical KSEI ownership snapshots for a ticker over time (monthly cadence). Use to track foreign ownership trend, e.g. "has foreign holding of TLKM increased over the last year?"',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Ticker code.' },
        ...optionalLimit
      },
      required: ['code']
    },
    build: (args) => ({
      url: `/ksei/ownership/${String(args.code).toUpperCase()}/history?limit=${(args.limit as number) ?? 24}`
    })
  },

  {
    name: 'get_top_foreign_owned',
    description:
      'List Indonesian stocks ranked by foreign ownership percentage on the latest KSEI snapshot. Useful for "which IDX stocks are most foreign-owned?"',
    inputSchema: {
      type: 'object',
      properties: { ...optionalLimit }
    },
    build: (args) => ({
      url: `/ksei/top-foreign-owned?limit=${(args.limit as number) ?? 20}`
    })
  },

  {
    name: 'get_foreign_flow',
    description:
      'List stocks ranked by absolute month-over-month change in foreign ownership shares — biggest accumulations and divestments by foreign investors. Use for "which stocks did foreign investors buy/sell most last month?"',
    inputSchema: {
      type: 'object',
      properties: { ...optionalLimit }
    },
    build: (args) => ({
      url: `/ksei/foreign-flow?limit=${(args.limit as number) ?? 20}`
    })
  },

  {
    name: 'get_top_movers',
    description:
      'Get top gainer or top loser stocks for a specific month. Returns top 20 by default. Use for "biggest winners on IDX in February 2026".',
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['gainer', 'loser'],
          description: 'Whether to return top gainers (price up) or top losers (price down).'
        },
        ...yearMonth,
        ...optionalLimit
      },
      required: ['direction', 'year', 'month']
    },
    build: (args) => ({
      url: `/trading/top-${args.direction}?year=${args.year}&month=${args.month}&limit=${(args.limit as number) ?? 20}`
    })
  },

  {
    name: 'get_indices',
    description:
      'List all 45 IDX market indices with current values, change, and percentage. Indices include COMPOSITE (IHSG), LQ45, IDX30, sector indices, and others. Use for "show me all IDX indices today".',
    inputSchema: {
      type: 'object',
      properties: { ...optionalLimit }
    },
    build: (args) => ({
      url: `/market/indices?limit=${(args.limit as number) ?? 60}`
    })
  },

  {
    name: 'get_index_summary',
    description:
      'Get OHLC + volume + market cap for all indices on a specific date. Use for "how did indices perform on 2026-02-24?"',
    inputSchema: {
      type: 'object',
      properties: { ...dateYmd, ...optionalLimit },
      required: ['date']
    },
    build: (args) => ({
      url: `/market/index-summary?date=${args.date}&limit=${(args.limit as number) ?? 60}`
    })
  },

  {
    name: 'get_sectoral_movement',
    description:
      'Get monthly performance by sector — which IDX sectors are rising or falling. Returns a time series across the month. Use for "which sectors moved last month?"',
    inputSchema: {
      type: 'object',
      properties: { ...yearMonth, ...optionalLimit },
      required: ['year', 'month']
    },
    build: (args) => ({
      url: `/market/sectoral-movement?year=${args.year}&month=${args.month}&limit=${(args.limit as number) ?? 200}`
    })
  },

  {
    name: 'get_dividend_calendar',
    description:
      'List dividend announcements for a specific month — record date, payment date, cash dividend per share. Use for "upcoming dividends" or "dividend history of MyTicker".',
    inputSchema: {
      type: 'object',
      properties: { ...yearMonth, ...optionalLimit },
      required: ['year', 'month']
    },
    build: (args) => ({
      url: `/data/dividend?year=${args.year}&month=${args.month}&limit=${(args.limit as number) ?? 100}`
    })
  },

  {
    name: 'get_financial_ratio',
    description:
      'Get financial ratios (PER, PBV, ROE, ROA, DER, EPS, book value, profit) per ticker for a given period. Use for fundamental screening like "show me companies with PER < 10 and ROE > 15".',
    inputSchema: {
      type: 'object',
      properties: { ...yearMonth, ...optionalLimit },
      required: ['year', 'month']
    },
    build: (args) => ({
      url: `/data/financial-ratio?year=${args.year}&month=${args.month}&limit=${(args.limit as number) ?? 200}`
    })
  },

  {
    name: 'get_stock_screener',
    description:
      'Get analytical metrics per ticker: market cap, PER, PBV, ROA, ROE, DER, NPM, week-4/13/26/52 returns, MTD, YTD, sector classification. Use for screening like "find me tech stocks with strong YTD returns".',
    inputSchema: {
      type: 'object',
      properties: { ...optionalLimit, ...optionalOffset }
    },
    build: (args) => ({
      url: `/stock-screener?limit=${(args.limit as number) ?? 100}&offset=${(args.offset as number) ?? 0}`
    })
  },

  {
    name: 'list_snapshots',
    description:
      'List available KSEI ownership snapshot dates. Useful to understand what historical periods are queryable.',
    inputSchema: { type: 'object', properties: {} },
    build: () => ({ url: '/ksei/snapshots' })
  },

  {
    name: 'list_endpoints',
    description:
      'Get the full Bursarium REST API resource tree — every available endpoint and parameter. Use when you need to find a specific data shape not covered by other tools.',
    inputSchema: { type: 'object', properties: {} },
    build: () => ({ url: '/' })
  }
]

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name)
}
