// Tool definitions for the Bursarium MCP server.
// Each tool wraps a Bursarium REST endpoint with a typed JSON-Schema input.
// We return responses as TOON for token efficiency (40% savings vs JSON).
//
// Two flavors:
//   1. Data tools (build URL → fetch from Bursarium API)
//   2. Presentation tools (no fetch, return structured payload that the
//      frontend recognizes and renders as a chart/stat/comparison/etc.)

export interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  /** URL builder + optional response filter. Omit for presentation-only tools. */
  build?: (args: Record<string, unknown>) => { url: string; postProcess?: (data: unknown) => unknown }
  /** Marks this tool as presentation-only (no API fetch, server echoes args). */
  presentation?: boolean
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
    name: 'get_top_by_investor_type',
    description:
      'Rank IDX stocks by share of ONE specific KSEI investor type (e.g., reksa dana asing / foreign mutual fund, dana pensiun lokal / local pension). Use for "top 10 stocks held by foreign mutual funds", "biggest local pension fund positions". Pick exactly one type from the enum.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'localIs','localCp','localPf','localIb','localId','localMf','localSc','localFd','localOt',
            'foreignIs','foreignCp','foreignPf','foreignIb','foreignId','foreignMf','foreignSc','foreignFd','foreignOt'
          ],
          description: 'Investor type. Format: {local|foreign}{Is=individual, Cp=corporate, Pf=pension, Ib=insurance/bank, Id=institution, Mf=mutual fund, Sc=securities firm, Fd=foundation, Ot=other}.'
        },
        ...optionalLimit
      },
      required: ['type']
    },
    build: (args) => ({
      url: `/ksei/top-by-type?type=${args.type}&limit=${(args.limit as number) ?? 20}`
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
      'Get OHLC + volume + market cap for all indices on ONE specific TRADING DAY (YYYYMMDD). For monthly/period analysis use get_daily_index instead. Example date: "20260224". Do NOT pass YYYYMM ("202602") — that is invalid.',
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
    name: 'get_daily_index',
    description:
      'Get the daily closing values for ALL indices across one calendar month — best for "how did IHSG move in February 2026?", or "show me daily LQ45 in March". Returns one row per (index, date). Filter client-side by name (e.g. "Composite Index" for IHSG). Year/month ARE separate numeric params.',
    inputSchema: {
      type: 'object',
      properties: { ...yearMonth, ...optionalLimit },
      required: ['year', 'month']
    },
    build: (args) => ({
      url: `/market/daily-index?year=${args.year}&month=${args.month}&limit=${(args.limit as number) ?? 500}`
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
  },

  // ====================================================================
  // PRESENTATION TOOLS — no API fetch, just echo structured payload that
  // the frontend renders as a chart, stat card, split bar, or table.
  // The model should call these AFTER it has data, to render the answer
  // as a mini-infographic instead of (or in addition to) plain text.
  // ====================================================================

  {
    name: 'present_stat',
    description:
      'Render a single big-number stat card (e.g., "BBCA foreign 72.73%"). Use this when the answer is one headline number that deserves emphasis. Always pair with prose text.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'Short label above the number, max 40 chars.' },
        value: { type: 'string', description: 'The headline number formatted for display ("72.73%", "Rp 6,450", "123.27 B saham").' },
        sub: { type: 'string', description: 'Optional sub-label below the number (e.g., "+2.4% MoM" or source date).' },
        accent: {
          type: 'string',
          enum: ['gain', 'loss', 'neutral'],
          description: 'Color tone — green for gain, red for loss, neutral for no direction.'
        }
      },
      required: ['label', 'value']
    },
    presentation: true
  },

  {
    name: 'present_chart_line',
    description:
      'Render a line chart for time-series data (e.g., foreign holding % over months, IHSG daily close). The frontend renders an editorial-style line with hover tooltip and area fill. Provide x as ISO dates or numeric labels and y as numbers in matching order.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Chart title.' },
        x: { type: 'array', items: { type: 'string' }, description: 'X-axis labels (e.g., ["2026-01-30","2026-02-27","2026-03-31"]).' },
        y: { type: 'array', items: { type: 'number' }, description: 'Y-axis values (same length as x).' },
        unit: { type: 'string', description: 'Unit suffix for y-values ("%", "Rp", null).' },
        accent: { type: 'string', enum: ['gain', 'loss', 'neutral'], description: 'Color tone.' }
      },
      required: ['title', 'x', 'y']
    },
    presentation: true
  },

  {
    name: 'present_chart_bar',
    description:
      'Render a horizontal bar ranking — for top-N lists like top gainers, top foreign-owned, biggest sectors. Each bar has a label, value, and optional sublabel.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        bars: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Ticker code, sector name, etc.' },
              value: { type: 'number', description: 'Numeric for bar length.' },
              sub: { type: 'string', description: 'Sublabel under the bar label (e.g., company name).' },
              displayValue: { type: 'string', description: 'How the value should appear next to the bar ("+90.48%" or "9.27 B").' },
              accent: { type: 'string', enum: ['gain', 'loss', 'neutral'] }
            },
            required: ['label', 'value']
          },
          description: 'Sorted bars in display order (caller decides ranking).'
        },
        unit: { type: 'string', description: 'Default unit if displayValue is absent.' }
      },
      required: ['title', 'bars']
    },
    presentation: true
  },

  {
    name: 'present_split',
    description:
      'Render a 100% stacked horizontal bar — for ownership composition (lokal vs asing), portfolio allocation, etc. Parts must sum to a positive total; their proportions are computed automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'number' },
              accent: { type: 'string', enum: ['gain', 'loss', 'neutral', 'ink', 'paper'] },
              displayValue: { type: 'string', description: 'How the part appears in the legend ("38.15B", "72.73%").' }
            },
            required: ['label', 'value']
          }
        }
      },
      required: ['title', 'parts']
    },
    presentation: true
  },

  {
    name: 'present_table',
    description:
      'Render a simple data table — for side-by-side comparisons, structured lists, or when bars/charts are too dense. Caller provides column headers and rows.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Column headers in display order.' },
        rows: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Each row is an array of strings, length matches columns.'
        }
      },
      required: ['title', 'columns', 'rows']
    },
    presentation: true
  },

  {
    name: 'present_compare',
    description:
      'Render a side-by-side comparison of two entities (e.g., BBCA vs BBRI). Each side gets a label, value, and optional sub.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        metric: { type: 'string', description: 'What is being compared, e.g., "PER" or "Foreign holding".' },
        left: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' },
            sub: { type: 'string' },
            accent: { type: 'string', enum: ['gain', 'loss', 'neutral'] }
          },
          required: ['label', 'value']
        },
        right: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' },
            sub: { type: 'string' },
            accent: { type: 'string', enum: ['gain', 'loss', 'neutral'] }
          },
          required: ['label', 'value']
        },
        verdict: { type: 'string', description: 'Optional one-line summary of which side wins / how they differ.' }
      },
      required: ['title', 'left', 'right']
    },
    presentation: true
  }
]

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name)
}

/**
 * Coerce string-typed args to numbers/booleans where the schema expects them.
 * Llama 3.3 frequently passes `{"year":"2026","month":"2"}` (strings) even
 * when we declare them as numbers — that fails downstream URL building and
 * looks like model self-failure. Walk the schema and cast in place.
 */
export function coerceArgs(tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const props = tool.inputSchema.properties as Record<string, { type?: string }>
  const out: Record<string, unknown> = { ...args }
  for (const [key, schema] of Object.entries(props)) {
    const v = out[key]
    if (v === undefined || v === null) continue
    if (schema.type === 'number' || schema.type === 'integer') {
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
        out[key] = Number(v)
      }
    } else if (schema.type === 'boolean') {
      if (typeof v === 'string') {
        if (v === 'true') out[key] = true
        else if (v === 'false') out[key] = false
      }
    }
  }
  return out
}
