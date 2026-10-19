/**
 * The MCP tool catalog (mcp/tools.json) is the single source both transports
 * read: the stdio bridge and the in-process HTTP server. It must stay in
 * lockstep with the renderer's control handler.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface ToolDef {
  name: string
  title: string
  description: string
  inputSchema: { type: string; additionalProperties?: boolean }
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

const root = resolve(__dirname, '../..')
const tools = JSON.parse(readFileSync(resolve(root, 'mcp/tools.json'), 'utf-8')) as ToolDef[]
const handlerSrc = readFileSync(resolve(root, 'src/renderer/control/handler.ts'), 'utf-8')

const READ_ONLY = ['get_state', 'list_assets', 'list_action_presets', 'list_sequence_styles', 'list_choreography_options', 'list_motion_presets', 'list_camera_moves', 'list_presets', 'screenshot']
const DESTRUCTIVE = ['delete_entity', 'clear_camera_marks', 'remove_scan']

describe('MCP tool catalog', () => {
  it('every tool is well-formed', () => {
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(t.title.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.inputSchema.type).toBe('object')
      expect(t.inputSchema.additionalProperties).toBe(false)
    }
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length)
  })

  it('annotations match the read-only and destructive sets', () => {
    const byName = new Map(tools.map((t) => [t.name, t]))
    for (const name of READ_ONLY) expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true)
    for (const name of DESTRUCTIVE) expect(byName.get(name)?.annotations?.destructiveHint, name).toBe(true)
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true, t.name).toBe(false)
      if (t.name.startsWith('list_')) expect(t.annotations?.readOnlyHint, t.name).toBe(true)
    }
  })

  it('catalog and renderer handler cover each other', () => {
    // top-level action cases only (4-space indent inside execute()); nested switches must not count
    const cases = [...handlerSrc.matchAll(/^ {4}case '([a-z_]+)'/gm)].map((m) => m[1])
    expect(new Set(cases)).toEqual(new Set(tools.map((t) => t.name)))
  })
})
