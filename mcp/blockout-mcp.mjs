#!/usr/bin/env node
// Modified for cross-platform Windows support and the fork's shared tool catalog in 2026; see MODIFICATIONS.md.
/**
 * Blockout MCP server — zero-dependency Node >=18 stdio bridge.
 *
 * Speaks the MCP stdio transport: newline-delimited JSON-RPC 2.0 on
 * stdin/stdout (NOT Content-Length framed). Each tools/call is forwarded to
 * the running app's HTTP control server, discovered via
 * Blockout's platform config directory (random localhost port + bearer token).
 *
 * Uses only node built-ins + global fetch — run directly with `node`.
 */

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

function configDir() {
  if (process.env.BLOCKOUT_CONFIG_DIR?.trim()) return process.env.BLOCKOUT_CONFIG_DIR.trim()
  if (process.platform === 'win32') {
    const namespace = process.env.BLOCKOUT_CONFIG_NAMESPACE || 'blockout'
    const segments = namespace.split(/[\\/]+/).filter((part) => part && part !== '.' && part !== '..')
    return join(
      process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      ...(segments.length > 0 ? segments : ['blockout'])
    )
  }
  return join(homedir(), '.config', 'blockout')
}

const DISCOVERY_FILES = process.env.BLOCKOUT_CONFIG_DIR?.trim()
  ? [join(configDir(), 'control.json')]
  : [...new Set([
      join(configDir(), 'control.json'),
      // Legacy descriptor location; descriptors without protocolVersion remain valid.
      join(homedir(), '.config', 'blockout', 'control.json')
    ])]
const PROTOCOL_VERSION = '2024-11-05'

/* --------------------------------- tools -------------------------------- */

// Each tool name maps to a control action of the SAME name; the tool's input
// object is passed through verbatim as that action's params. The catalog lives
// in tools.json so this bridge and the in-app HTTP server serve the same tools.
const TOOLS = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf-8'))

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name))

/* ------------------------------ control call ---------------------------- */

const NOT_RUNNING = "Blockout isn't running — launch the app first."

async function callControl(action, params) {
  let config
  for (const file of DISCOVERY_FILES) {
    try {
      const candidate = JSON.parse(await readFile(file, 'utf-8'))
      if (Number.isInteger(candidate?.port) && typeof candidate?.token === 'string') {
        config = candidate
        break
      }
    } catch {
      // Try the next current/legacy discovery location.
    }
  }
  if (!config || (config.protocolVersion !== undefined && config.protocolVersion !== 1) ||
    (config.app !== undefined && config.app !== 'blockout')) {
    return { error: NOT_RUNNING }
  }
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`
      },
      body: JSON.stringify({ action, params: params ?? {} })
    })
    return { response: await res.json() }
  } catch {
    return { error: NOT_RUNNING }
  }
}

/* ---------------------------- JSON-RPC plumbing ------------------------- */

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handleToolCall(id, params) {
  const name = params?.name
  const args = params?.arguments ?? {}
  if (!TOOL_NAMES.has(name)) {
    reply(id, { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true })
    return
  }
  const { response, error } = await callControl(name, args)
  if (error) {
    reply(id, { content: [{ type: 'text', text: error }], isError: true })
    return
  }
  // Image special-case: an ok screenshot returns base64 PNG data.
  if (response && response.ok && response.data && typeof response.data.imageBase64 === 'string') {
    reply(id, { content: [{ type: 'image', data: response.data.imageBase64, mimeType: 'image/png' }] })
    return
  }
  reply(id, {
    content: [{ type: 'text', text: JSON.stringify(response) }],
    isError: response && response.ok === false
  })
}

async function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'blockout', version: '1.0.0' }
      })
      return
    case 'notifications/initialized':
      return // notification, no reply
    case 'tools/list':
      reply(id, { tools: TOOLS })
      return
    case 'tools/call':
      await handleToolCall(id, params)
      return
    case 'ping':
      reply(id, {})
      return
    default:
      // Notifications (no id) are ignored; requests get method-not-found.
      if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`)
      return
  }
}

/* ------------------------------- stdin loop ----------------------------- */

let buffer = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue // ignore non-JSON lines
    }
    void handle(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
