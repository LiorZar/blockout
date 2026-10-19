/**
 * The in-process Streamable HTTP MCP server (src/main/mcp-http.ts), run under
 * Node with a fake `invoke` in place of the renderer control path.
 */
import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import catalog from '../../mcp/tools.json'
import {
  createMcpHttpServer,
  resolveMcpPort,
  MCP_DEFAULT_PORT,
  type InvokeFn,
  type McpHttpServer,
  type McpToolDef
} from '../../src/main/mcp-http'

const tools = catalog as McpToolDef[]

type Call = { action: string; params: unknown }

let server: McpHttpServer | null = null
let client: Client | null = null
let blocker: net.Server | null = null

afterEach(async () => {
  await client?.close().catch(() => {})
  client = null
  await server?.stop()
  server = null
  await new Promise<void>((r) => (blocker ? blocker.close(() => r()) : r()))
  blocker = null
})

async function start(response: Awaited<ReturnType<InvokeFn>> = { ok: true, data: { hello: 1 } }): Promise<{ port: number; calls: Call[] }> {
  const calls: Call[] = []
  server = createMcpHttpServer({
    invoke: async (action, params) => {
      calls.push({ action, params })
      return response
    },
    version: '9.9.9',
    tools
  })
  const status = await server.start(0)
  expect(status.state).toBe('listening')
  expect(status.url).toBe(`http://127.0.0.1:${status.port}/mcp`)
  return { port: status.port!, calls }
}

async function connect(port: number): Promise<Client> {
  client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)))
  return client
}

function raw(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: opts.method ?? 'GET', path: opts.path ?? '/mcp', headers: opts.headers },
      (res) => {
        let body = ''
        res.setEncoding('utf-8')
        res.on('data', (c: string) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    req.end(opts.body)
  })
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } }
})
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }

describe('MCP HTTP server', () => {
  it('lists exactly the catalog', async () => {
    const { port } = await start()
    const listed = await (await connect(port)).listTools()
    expect(listed.tools.length).toBe(tools.length)
    const shot = listed.tools.find((t) => t.name === 'get_state')
    expect(shot?.title).toBe(tools.find((t) => t.name === 'get_state')?.title)
    expect(shot?.annotations?.readOnlyHint).toBe(true)
  })

  it('relays a call', async () => {
    const { port, calls } = await start({ ok: true, data: { project: 'P' } })
    const result = await (await connect(port)).callTool({ name: 'get_state', arguments: {} })
    expect(calls).toEqual([{ action: 'get_state', params: {} }])
    const content = result.content as { type: string; text: string }[]
    expect(JSON.parse(content[0]!.text)).toEqual({ ok: true, data: { project: 'P' } })
    expect(result.isError).toBe(false)
  })

  it('screenshot becomes an image', async () => {
    const { port } = await start({ ok: true, data: { imageBase64: 'iVBO' } })
    const result = await (await connect(port)).callTool({ name: 'screenshot', arguments: {} })
    const content = result.content as { type: string; data: string; mimeType: string }[]
    expect(content[0]).toEqual({ type: 'image', data: 'iVBO', mimeType: 'image/png' })
  })

  it('failed action is isError', async () => {
    const { port } = await start({ ok: false, error: 'No entity "x".' })
    const result = await (await connect(port)).callTool({ name: 'delete_entity', arguments: { entityId: 'x' } })
    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]!.text).toContain('No entity')
  })

  it('unknown tool is isError and never reaches the app', async () => {
    const { port, calls } = await start()
    const result = await (await connect(port)).callTool({ name: 'format_disk', arguments: {} })
    expect(result.isError).toBe(true)
    expect((result.content as { text: string }[])[0]!.text).toBe('Unknown tool: format_disk')
    expect(calls).toEqual([])
  })

  it('rejects a foreign Host', async () => {
    const { port, calls } = await start()
    const res = await raw(port, { method: 'POST', headers: { ...JSON_HEADERS, Host: `evil.example:${port}` }, body: INIT })
    expect(res.status).toBe(403)
    expect(calls).toEqual([])
  })

  it('rejects any Origin', async () => {
    const { port } = await start()
    const res = await raw(port, { method: 'POST', headers: { ...JSON_HEADERS, Origin: 'http://127.0.0.1' }, body: INIT })
    expect(res.status).toBe(403)
    const health = await raw(port, { path: '/health', headers: { Origin: 'https://evil.example' } })
    expect(health.status).toBe(403)
  })

  it('accepts localhost as the Host', async () => {
    const { port } = await start()
    const res = await raw(port, { method: 'POST', headers: { ...JSON_HEADERS, Host: `localhost:${port}` }, body: INIT })
    expect(res.status).toBe(200)
  })

  it('GET /mcp is 405 with Allow: POST; unknown path is 404; /health is 200', async () => {
    const { port } = await start()
    const get = await raw(port, { path: '/mcp' })
    expect(get.status).toBe(405)
    expect(get.headers.allow).toBe('POST')
    expect((await raw(port, { path: '/nope' })).status).toBe(404)
    const health = await raw(port, { path: '/health' })
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, app: 'blockout' })
  })

  it('busy port reports error', async () => {
    blocker = net.createServer()
    await new Promise<void>((r) => blocker!.listen(0, '127.0.0.1', () => r()))
    const busy = (blocker.address() as net.AddressInfo).port
    server = createMcpHttpServer({ invoke: async () => ({ ok: true }), version: '1', tools })
    const status = await server.start(busy)
    expect(status.state).toBe('error')
    expect(status.message).toContain('EADDRINUSE')
    expect(server.status().state).toBe('error')
  })

  it('stop refuses new requests', async () => {
    const { port } = await start()
    expect((await raw(port, { path: '/health' })).status).toBe(200)
    await server!.stop()
    expect(server!.status().state).toBe('stopped')
    await expect(raw(port, { path: '/health' })).rejects.toThrow()
  })
})

describe('resolveMcpPort', () => {
  it('defaults and validates BLOCKOUT_MCP_PORT', () => {
    expect(MCP_DEFAULT_PORT).toBe(17480)
    expect(resolveMcpPort({})).toBe(17480)
    expect(resolveMcpPort({ BLOCKOUT_MCP_PORT: '0' })).toBe(0)
    expect(resolveMcpPort({ BLOCKOUT_MCP_PORT: '18000' })).toBe(18000)
    expect(resolveMcpPort({ BLOCKOUT_MCP_PORT: '80' })).toBe(17480)
    expect(resolveMcpPort({ BLOCKOUT_MCP_PORT: 'abc' })).toBe(17480)
    expect(resolveMcpPort({ BLOCKOUT_MCP_PORT: '65536' })).toBe(17480)
    expect(resolveMcpPort({ BLOCKOUT_MCP_PORT: '1.5e4' })).toBe(17480)
  })
})
