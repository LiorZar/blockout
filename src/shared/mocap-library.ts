/**
 * The local Mixamo library (fork addition; see MODIFICATIONS.md): where it
 * lives, which files a read may reach, and the manifest's shape. The files
 * are the user's own downloads in `<config dir>/mixamo/` and never ship with
 * Blockout.
 */

import { resolve, sep } from 'path'
import { resolveConfigPath, type ConfigPathOptions } from './config-paths'
import { normalizeProjectRelativePath } from './portable-paths'

export interface MocapManifestCharacter {
  key: string
  name: string
  body: 'male' | 'female'
  file: string
}

export interface MocapManifestClip {
  key: string
  group: string
  name: string
  file: string
  inPlace?: boolean
  loop?: boolean
  fps?: number
}

export interface MocapManifest {
  version: 1
  characters: MocapManifestCharacter[]
  clips: MocapManifestClip[]
}

/** The library folder (`BLOCKOUT_CONFIG_DIR` moves it with the rest of the config). */
export function mocapLibraryDir(options: ConfigPathOptions = {}): string {
  return resolveConfigPath('mixamo', options)
}

/** A file inside the library, or null when the path is absolute or would leave it. */
export function mocapLibraryPath(dir: string, relativePath: string): string | null {
  const portable = normalizeProjectRelativePath(relativePath)
  if (!portable) return null
  const base = resolve(dir)
  const full = resolve(base, ...portable.split('/'))
  return full !== base && full.startsWith(base + sep) ? full : null
}

/** The manifest, or null when it isn't one (wrong version, no characters). */
export function parseMocapManifest(json: unknown): MocapManifest | null {
  const m = json as Partial<MocapManifest> | null
  if (!m || m.version !== 1 || !Array.isArray(m.characters)) return null
  const characters = m.characters.filter(
    (c): c is MocapManifestCharacter =>
      !!c && typeof c.key === 'string' && typeof c.name === 'string' && (c.body === 'male' || c.body === 'female') && typeof c.file === 'string'
  )
  const clips = (Array.isArray(m.clips) ? m.clips : []).filter(
    (c): c is MocapManifestClip => !!c && typeof c.key === 'string' && typeof c.name === 'string' && typeof c.group === 'string' && typeof c.file === 'string'
  )
  return characters.length > 0 ? { version: 1, characters, clips } : null
}
