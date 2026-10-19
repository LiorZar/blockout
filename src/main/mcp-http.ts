/**
 * In-process MCP server over Streamable HTTP, so any MCP client (Claude Code,
 * Codex, Copilot, Clara) reaches the running app at a stable URL without a
 * `node` binary on the machine. Serves the same catalog as the stdio bridge
 * (mcp/tools.json) and relays every call through the control path
 * (`invoke` → renderer handler), so edits stay undoable and visible live.
 *
 * Localhost only: binds 127.0.0.1 and refuses any request whose Host isn't
 * 127.0.0.1/localhost on our port, or that carries an Origin (a browser page).
 * Stateless: a fresh SDK Server + transport per request.
 *
 * No `electron` import — the unit tests run this under Node.
 */

import http from 'http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export type InvokeFn = (action: string, params: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }>

export interface McpToolDef {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

export interface McpHttpStatus {
  state: 'stopped' | 'listening' | 'error'
  port?: number
  url?: string
  message?: string
}

export interface McpHttpServer {
  /** Never rejects: a busy port resolves `{ state: 'error' }`. */
  start(port: number): Promise<McpHttpStatus>
  stop(): Promise<void>
  status(): McpHttpStatus
}

export const MCP_DEFAULT_PORT = 17480

/** `BLOCKOUT_MCP_PORT`: an integer 0 (any free port) or 1024..65535; else the default. */
export function resolveMcpPort(env: NodeJS.ProcessEnv): number {
  const raw = env.BLOCKOUT_MCP_PORT?.trim()
  if (!raw || !/^\d+$/.test(raw)) return MCP_DEFAULT_PORT
  const port = Number(raw)
  return port === 0 || (port >= 1024 && port <= 65535) ? port : MCP_DEFAULT_PORT
}

/** A control response → an MCP tool result (mirrors mcp/blockout-mcp.mjs). */
export function toToolResult(response: Awaited<ReturnType<InvokeFn>>): CallToolResult {
  const data = response.data as { imageBase64?: unknown } | undefined
  if (response.ok && data && typeof data.imageBase64 === 'string') {
    return { content: [{ type: 'image', data: data.imageBase64, mimeType: 'image/png' }] }
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(response) }],
    isError: response.ok === false
  }
}

export function createMcpHttpServer(opts: { invoke: InvokeFn; version: string; tools: McpToolDef[] }): McpHttpServer {
  const names = new Set(opts.tools.map((t) => t.name))
  let current: McpHttpStatus = { state: 'stopped' }
  let httpServer: http.Server | null = null

  function buildServer(): Server {
    const server = new Server({ name: 'blockout', version: opts.version }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: opts.tools as never }))
    server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
      const { name, arguments: args } = req.params
      if (!names.has(name)) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
      return toToolResult(await opts.invoke(name, args ?? {}))
    })
    return server
  }

  function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }

  function onRequest(port: number, req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = req.headers.host
    if ((host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) || req.headers.origin !== undefined) {
      json(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    const path = (req.url ?? '').split('?')[0]
    if (path === '/health') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' }, { Allow: 'GET' })
      return json(res, 200, { ok: true, app: 'blockout', version: opts.version })
    }
    if (path !== '/mcp') return json(res, 404, { ok: false, error: 'not found' })
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' }, { Allow: 'POST' })

    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    void (async () => {
      try {
        await server.connect(transport)
        await transport.handleRequest(req, res)
      } catch (e) {
        if (!res.headersSent) json(res, 500, { ok: false, error: (e as Error).message })
      }
    })()
  }

  return {
    status: () => ({ ...current }),

    start(port) {
      if (httpServer) return Promise.resolve({ ...current })
      return new Promise((resolve) => {
        const server = http.createServer()
        // Exports run up to 600 s inside one tools/call.
        server.requestTimeout = 0
        server.once('error', (err: NodeJS.ErrnoException) => {
          httpServer = null
          current = { state: 'error', message: err.message }
          resolve({ ...current })
        })
        server.listen(port, '127.0.0.1', () => {
          const addr = server.address()
          const bound = typeof addr === 'object' && addr ? addr.port : port
          server.on('request', (req, res) => onRequest(bound, req, res))
          httpServer = server
          current = { state: 'listening', port: bound, url: `http://127.0.0.1:${bound}/mcp` }
          resolve({ ...current })
        })
      })
    },

    stop() {
      const server = httpServer
      httpServer = null
      current = { state: 'stopped' }
      if (!server) return Promise.resolve()
      return new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    }
  }
}
