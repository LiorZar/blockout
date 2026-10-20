// Fork addition (2026): the local Mixamo library: confinement, manifest, extraction; see MODIFICATIONS.md.
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { clearMocapBodies, mocapRig } from '@engine/mocap/registry'
import { fitMocapRig, MOCAP_BONES } from '@engine/mocap/rig'
import { extractMocap } from '@renderer/mocap/extract'
import { registerMocapTemplate } from '@renderer/mocap/library'
import { mocapLibraryDir, mocapLibraryPath, parseMocapManifest } from '../../src/shared/mocap-library'
import { fixtureSource } from './mocap-fixture'
import { fixtureCharacter } from './mocap-three-fixture'

afterAll(() => clearMocapBodies())

describe('mocap library files', () => {
  it('reads only inside the library folder', () => {
    const dir = resolve('some', 'config', 'mixamo')
    expect(mocapLibraryPath(dir, 'characters/y-bot.fbx')).toBe(join(dir, 'characters', 'y-bot.fbx'))
    expect(mocapLibraryPath(dir, 'clips\\walk.fbx')).toBe(join(dir, 'clips', 'walk.fbx'))
    for (const bad of ['../secret.txt', 'clips/../../x', '/etc/passwd', 'C:/Windows/win.ini', '//server/share', '', '.']) expect(mocapLibraryPath(dir, bad), bad).toBeNull()
  })

  it('lives in the config dir, so BLOCKOUT_CONFIG_DIR moves it', () => {
    expect(mocapLibraryDir({ env: { BLOCKOUT_CONFIG_DIR: 'X:/cfg' } as NodeJS.ProcessEnv, platform: 'win32' })).toBe('X:\\cfg\\mixamo')
  })

  it('accepts a version-1 manifest with characters and drops malformed entries', () => {
    const m = parseMocapManifest({
      version: 1,
      characters: [{ key: 'a', name: 'A', body: 'male', file: 'characters/a.fbx' }, { key: 'b', body: 'other' }],
      clips: [{ key: 'walk', group: 'gait', name: 'Walking', file: 'clips/walk.fbx' }, null]
    })
    expect(m?.characters.map((c) => c.key)).toEqual(['a'])
    expect(m?.clips.map((c) => c.key)).toEqual(['walk'])
    expect(parseMocapManifest({ version: 2, characters: [] })).toBeNull()
    expect(parseMocapManifest({ version: 1, characters: [] })).toBeNull()
    expect(parseMocapManifest(null)).toBeNull()
  })
})

describe('extracting a character', () => {
  it('reads the bind pose in entity space (m, facing −Z) and skips duplicate bones', () => {
    const src = extractMocap(fixtureCharacter())
    const want = fixtureSource()
    expect(src.bones.map((b) => b.name)).toEqual(want.bones.map((b) => b.name))
    src.bones.forEach((b, i) => {
      const w = want.bones[i]!
      expect(b.parent).toBe(w.parent)
      expect(Math.hypot(b.p.x - w.p.x, b.p.y - w.p.y, b.p.z - w.p.z), b.name).toBeLessThan(1e-6)
      const dot = Math.abs(b.q[0] * w.q[0] + b.q[1] * w.q[1] + b.q[2] * w.q[2] + b.q[3] * w.q[3])
      expect(dot, b.name).toBeCloseTo(1, 9)
    })
  })

  it('fits the same body as the engine fixture (vertices on their heaviest bone)', () => {
    const a = fitMocapRig(extractMocap(fixtureCharacter()), 1.8)
    const b = fitMocapRig(fixtureSource(), 1.8)
    for (const key of Object.keys(b.dims) as (keyof typeof b.dims)[]) expect(a.dims[key], key).toBeCloseTo(b.dims[key], 5)
    expect(a.scale).toBeCloseTo(b.scale, 6)
  })

  it('registers a template with the engine', () => {
    registerMocapTemplate('person.mocapMale', fixtureCharacter())
    expect(mocapRig('person.mocapMale')?.dims.H).toBe(1.8)
  })
})

const LIBRARY = mocapLibraryDir()
const HAS_LIBRARY = existsSync(join(LIBRARY, 'manifest.json'))

describe.skipIf(!HAS_LIBRARY)('the local Mixamo library (skipped without it)', () => {
  it('both characters parse, extract and fit as people of their catalog height', () => {
    const manifest = parseMocapManifest(JSON.parse(readFileSync(join(LIBRARY, 'manifest.json'), 'utf-8')))!
    for (const body of ['male', 'female'] as const) {
      const c = manifest.characters.find((x) => x.body === body)!
      const buf = readFileSync(mocapLibraryPath(LIBRARY, c.file)!)
      const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '')
      const src = extractMocap(root)
      for (const name of MOCAP_BONES) expect(src.bones.some((b) => b.name === name), name).toBe(true)
      const height = body === 'male' ? 1.8 : 1.7
      const rig = fitMocapRig(src, height)
      const d = rig.dims
      expect(d.H).toBe(height)
      // Human proportions (not measurements): legs about half the height, arms hanging to mid-thigh.
      expect(d.legLen / d.H).toBeGreaterThan(0.42)
      expect(d.legLen / d.H).toBeLessThan(0.56)
      expect((d.upperArmLen + d.lowerArmLen) / d.H).toBeGreaterThan(0.3)
      expect((d.upperArmLen + d.lowerArmLen) / d.H).toBeLessThan(0.42)
      expect(rig.points.length).toBeGreaterThan(400)
      expect(rig.torso.rings.length).toBeGreaterThan(10)
    }
  }, 120_000)
})
