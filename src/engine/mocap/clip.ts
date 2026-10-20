/**
 * Mocap clips (fork addition; see MODIFICATIONS.md): the library's Mixamo
 * takes as plain data. The renderer samples each FBX take at its frames and
 * registers per frame the core bones' world rotations and the hips joint
 * (entity space); the engine keeps them as rig rotations G relative to the
 * source bot's A-rest (W · restQ⁻¹), so any bot plays a clip as G · restQ
 * (the bind correction of `fk.ts`), its hips scaled by its hip height.
 *
 * - `clipSample` reads a clip at a time: looping or clamped, mirrored left /
 *   right on request. A root-motion clip's hips travel comes out as `root`
 *   (the evaluator moves the entity by it), so the pose's hips stay over the
 *   root; an in-place clip keeps its sway in the pose.
 * - `clipPose` poses a bot from a sample plus an additive overlay of the
 *   rig's joint channels (each pre-multiplies the clip's local rotation of
 *   its bone: the torso in thirds over the spine, the head half on the neck,
 *   the root channels about the hips).
 * - `mocapClipPose` resolves a `ClipState` (crossfades on the shortest arc)
 *   and grounds the pose: its lowest point sits at the clip's clearance (the
 *   source bot's height off its floor past a contact band, `CONTACT`),
 *   scaled to the bot. Every consumer (floor, weapons, shot words, the
 *   renderer) sees the same grounded pose.
 *
 * PURE: no DOM / three.js / Electron. Clips are registered at startup
 * (exports wait for the library), never on the `state(t)` path.
 */

import type { Effector, PoseFrames } from '../skeleton'
import type { ClipState, V3 } from '../types'
import { effectorsOf, jointLocals, mocapPose, poseFramesOf, type MocapDims, type MocapPose, type RigLocals } from './fk'
import { qconj, qmul, qnorm, qpow, qrot, qslerp, vadd, vscale, type Quat } from './quat'
import { mocapRig } from './registry'
import { BONE_INDEX, MOCAP_BONES, type MocapBone } from './rig'

const N = MOCAP_BONES.length

/** What the renderer reads out of a clip file (entity space: metres, +Y up, facing −Z). */
export interface MocapClipSource {
  /** The bot the clip was captured on: its A-rest is the clip's reference. */
  source: string
  fps: number
  loop?: boolean
  inPlace?: boolean
  /** Per frame, the core bones' world rotations, MOCAP_BONES order, [x, y, z, w] (frames × bones × 4). */
  rot: ArrayLike<number>
  /** Per frame, the hips joint (frames × 3). */
  hips: ArrayLike<number>
  /** Per frame, world rotations of bones beyond the core (fingers), by name (frames × names × 4). */
  extra?: { names: string[]; rot: ArrayLike<number> }
}

export interface MocapClip {
  id: string
  source: string
  fps: number
  frames: number
  /** Seconds from the first frame to the last. */
  duration: number
  loop: boolean
  inPlace: boolean
  /** Rig rotations per frame and core bone (frames × bones × 4). */
  G: Float64Array
  /** The pose's hips joint per frame, source rig metres (root travel taken out). */
  hips: Float64Array
  /** Root travel per frame (x, z; source rig metres): the hips' on a root-motion clip, else 0. */
  root: Float64Array
  /** Per frame, the source bot's lowest point over its floor less the contact band (m, ≥ 0). */
  clear: Float64Array
  /** The source bot's A-rest hips height: a bot plays the hips scaled by its own over this. */
  hipH: number
  /** Bones beyond the core it turns (fingers), and their rig rotations per frame (frames × names × 4). */
  xNames: string[]
  GX: Float64Array
}

/** A clip read at one time. */
export interface ClipSample {
  G: Quat[]
  hips: V3
  root: { x: number; z: number }
  clear: number
  hipH: number
  /** Rig rotations of the bones beyond the core it turns, by name. */
  X: Map<string, Quat>
}

/**
 * The contact band (m): a source frame whose lowest point is within it of
 * the floor touches it. Mixamo's takes stand on their floor to a few
 * millimetres but sink hands and arms 4–12 cm into it when on the ground, so
 * a frame below the band is grounded exactly and one above keeps its height
 * (less the band): a jump stays a jump, a fall lands on the floor.
 */
export const CONTACT = 0.02

/** An in-place take's hips end within this ahead of where they start (m): more is travel to take out. */
const IN_PLACE = 0.25

const CLIPS = new Map<string, MocapClip>()
let version = 0

/** Left ↔ right counterpart of each core bone. */
const MIRROR: number[] = MOCAP_BONES.map((b) => {
  const other = b.startsWith('Left') ? b.replace('Left', 'Right') : b.startsWith('Right') ? b.replace('Right', 'Left') : b
  return BONE_INDEX[other as MocapBone]
})

/** A rotation reflected through the body's midplane (x → −x). */
const reflect = (q: Quat): Quat => [q[0], -q[1], -q[2], q[3]]

function quatAt(a: ArrayLike<number>, i: number): Quat {
  return [a[4 * i]!, a[4 * i + 1]!, a[4 * i + 2]!, a[4 * i + 3]!]
}

/** Register a clip (throws when its source bot isn't registered or the data is short). */
export function registerMocapClip(id: string, src: MocapClipSource): MocapClip {
  const rig = mocapRig(src.source)
  if (!rig) throw new Error(`mocap clip ${id}: ${src.source} isn't loaded`)
  const frames = Math.floor(src.hips.length / 3)
  if (frames < 1 || src.rot.length < frames * N * 4) throw new Error(`mocap clip ${id}: ${frames} frames, ${src.rot.length / 4} rotations`)
  if (!(src.fps > 0)) throw new Error(`mocap clip ${id}: fps ${src.fps}`)
  const inPlace = !!src.inPlace
  // A take flagged in place whose hips walk forward over planted feet anyway (the library's sprint): its
  // straight-line travel comes out (the sway stays), so it plays in place, its feet sliding back under it.
  const last = 3 * (frames - 1)
  const drift = { x: src.hips[last]! - src.hips[0]!, z: src.hips[last + 2]! - src.hips[2]! }
  const detrend = inPlace && -drift.z * rig.scale > IN_PLACE ? 1 / Math.max(1, frames - 1) : 0
  const restX = new Map(rig.extra.map((x) => [x.name, x.restQ]))
  const xi = (src.extra?.names ?? []).map((name, i) => [name, i] as const).filter(([name]) => restX.has(name))
  const xNames = xi.map(([name]) => name)
  const E = src.extra?.names.length ?? 0
  const GX = new Float64Array(frames * xNames.length * 4)
  for (let f = 0; f < frames; f++)
    xi.forEach(([name, i], k) => GX.set(qnorm(qmul(qnorm(quatAt(src.extra!.rot, f * E + i)), qconj(restX.get(name)!))), (f * xNames.length + k) * 4))
  const G = new Float64Array(frames * N * 4)
  const hips = new Float64Array(frames * 3)
  const root = new Float64Array(frames * 2)
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) {
      const g = qnorm(qmul(qnorm(quatAt(src.rot, f * N + i)), qconj(rig.restQ[i]!)))
      G.set(g, (f * N + i) * 4)
    }
    const x = (src.hips[3 * f]! - drift.x * f * detrend - rig.centre.x) * rig.scale
    const y = (src.hips[3 * f + 1]! - rig.centre.y) * rig.scale
    const z = (src.hips[3 * f + 2]! - drift.z * f * detrend - rig.centre.z) * rig.scale
    if (inPlace) hips.set([x, y, z], 3 * f)
    else {
      hips.set([0, y, 0], 3 * f)
      root.set([x, z], 2 * f)
    }
  }
  const clip: MocapClip = {
    id,
    source: src.source,
    fps: src.fps,
    frames,
    duration: (frames - 1) / src.fps,
    loop: !!src.loop,
    inPlace,
    G,
    hips,
    root,
    clear: new Float64Array(frames),
    hipH: rig.rest[BONE_INDEX.Hips]!.y,
    xNames,
    GX
  }
  fillClear(clip)
  CLIPS.set(id, clip)
  // The clips made from this one (and another registered clip).
  for (const [name, d] of Object.entries(RESTED_ARMS)) {
    const base = CLIPS.get(d.base)
    const arms = CLIPS.get(d.arms)
    if ((d.base === id || d.arms === id) && base && arms) CLIPS.set(name, restArms(name, base, arms))
  }
  version++
  return clip
}

/** Clearance: how far the source bot is off its floor, past a contact band, per frame. */
function fillClear(clip: MocapClip): void {
  const m: MocapDims = { rig: mocapRig(clip.source)!, k: 1 }
  for (let f = 0; f < clip.frames; f++) clip.clear[f] = Math.max(0, poseLowY(m, clipPose(m, frameSample(clip, f))) - CONTACT)
}

/**
 * Clips made from two registered clips, built as soon as both are: `base`
 * with its arms and hands at rest the way `arms` holds them (each arm bone's
 * and finger's mean rotation under its parent over that clip). The library's
 * crouch idle holds one hand up the whole loop; the crouched walk's arms hang.
 */
export const RESTED_ARMS: Record<string, { base: string; arms: string }> = {
  crouchStill: { base: 'crouchIdle', arms: 'crouchWalk' }
}

const ARM_BONES = (['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'] as const).map((b) => BONE_INDEX[b])

/** The mean of rotations (signs aligned to the first), normalised. */
function qmean(qs: Quat[]): Quat {
  const s: Quat = [0, 0, 0, 0]
  for (const q of qs) {
    const k = q[0] * qs[0]![0] + q[1] * qs[0]![1] + q[2] * qs[0]![2] + q[3] * qs[0]![3] < 0 ? -1 : 1
    for (let c = 0; c < 4; c++) s[c] = s[c]! + k * q[c]!
  }
  return qnorm(s)
}

/** `base` with the arms (and the bones beyond them) at `donor`'s mean rotations under their parents. */
function restArms(id: string, base: MocapClip, donor: MocapClip): MocapClip {
  const m: MocapDims = { rig: mocapRig(base.source)!, k: 1 }
  const rig = m.rig
  const local = (G: ArrayLike<number>, f: number, i: number): Quat => qmul(qconj(quatAt(G, f * N + rig.parent[i]!)), quatAt(G, f * N + i))
  const armMean = new Map(ARM_BONES.map((i) => [i, qmean(Array.from({ length: donor.frames }, (_, f) => local(donor.G, f, i)))]))
  // The bones beyond the core that hang off an arm, and the donor's mean of each it turns.
  const onArm: boolean[] = []
  for (const x of rig.extra) onArm.push(x.parent < N ? ARM_BONES.includes(x.parent) : onArm[x.parent - N]!)
  const donorX = Array.from({ length: donor.frames }, (_, f) => sampleLocals(m, frameSample(donor, f)))
  const xMean = new Map<string, Quat>()
  rig.extra.forEach((x, e) => {
    const qs = donorX.map((l) => l.get(x.name)).filter((q): q is Quat => !!q)
    if (onArm[e] && qs.length === donor.frames) xMean.set(x.name, qmean(qs))
  })
  const G = new Float64Array(base.G)
  const xs: Map<string, Quat>[] = []
  for (let f = 0; f < base.frames; f++) {
    for (const i of ARM_BONES) G.set(qmul(quatAt(G, f * N + rig.parent[i]!), armMean.get(i)!), (f * N + i) * 4)
    const own = sampleLocals(m, frameSample(base, f))
    xs.push(new Map(rig.extra.map((x, e) => [x.name, onArm[e] ? xMean.get(x.name) : own.get(x.name)] as const).filter((p): p is [string, Quat] => !!p[1])))
  }
  // The bones beyond the core as rig rotations (the ones it turns; the rest ride their parents).
  const xNames = rig.extra.map((x) => x.name).filter((name) => xs.every((l) => l.has(name)))
  const GX = new Float64Array(base.frames * xNames.length * 4)
  for (let f = 0; f < base.frames; f++) {
    const pose = withExtras(m, chain(m, Array.from({ length: N }, (_, i) => quatAt(G, f * N + i)), { x: 0, y: 0, z: 0 }), xs[f])
    xNames.forEach((name, k) => GX.set(pose.XG![rig.extra.findIndex((x) => x.name === name)]!, (f * xNames.length + k) * 4))
  }
  const clip: MocapClip = { ...base, id, G, clear: new Float64Array(base.frames), xNames, GX }
  fillClear(clip)
  return clip
}

export function mocapClip(id: string): MocapClip | undefined {
  return CLIPS.get(id)
}

export function mocapClipIds(): string[] {
  return [...CLIPS.keys()]
}

/** Forget every clip (tests). */
export function clearMocapClips(): void {
  CLIPS.clear()
  version++
}

/** Changes on every (un)registration, for caches. */
export function mocapClipVersion(): number {
  return version
}

function frameSample(clip: MocapClip, f: number): ClipSample {
  const G: Quat[] = new Array(N)
  for (let i = 0; i < N; i++) G[i] = quatAt(clip.G, f * N + i)
  const E = clip.xNames.length
  return {
    G,
    hips: { x: clip.hips[3 * f]!, y: clip.hips[3 * f + 1]!, z: clip.hips[3 * f + 2]! },
    root: { x: clip.root[2 * f]!, z: clip.root[2 * f + 1]! },
    clear: clip.clear[f]!,
    hipH: clip.hipH,
    X: new Map(clip.xNames.map((name, k) => [name, quatAt(clip.GX, f * E + k)]))
  }
}

/**
 * A clip at clip time `t` (s): a loop wraps (its root travel carries on
 * cycle after cycle), anything else holds its first and last frames.
 */
export function clipSample(clip: MocapClip, t: number, mirror = false): ClipSample {
  const D = clip.duration
  let n = 0
  let tt = 0
  if (D > 0) {
    if (clip.loop) {
      n = Math.floor(t / D)
      tt = t - n * D
    } else tt = Math.min(D, Math.max(0, t))
  }
  const last = clip.frames - 1
  const f = Math.min(last, tt * clip.fps)
  const i = Math.min(Math.floor(f), Math.max(0, last - 1))
  const j = Math.min(i + 1, last)
  const u = j > i ? f - i : 0
  const G: Quat[] = new Array(N)
  for (let b = 0; b < N; b++) G[b] = qslerp(quatAt(clip.G, i * N + b), quatAt(clip.G, j * N + b), u)
  const lerp = (a: Float64Array, w: number, k: number): number => a[w * i + k]! + (a[w * j + k]! - a[w * i + k]!) * u
  const root = { x: lerp(clip.root, 2, 0), z: lerp(clip.root, 2, 1) }
  if (n !== 0) {
    root.x += n * (clip.root[2 * last]! - clip.root[0]!)
    root.z += n * (clip.root[2 * last + 1]! - clip.root[1]!)
  }
  const E = clip.xNames.length
  const X = new Map(clip.xNames.map((name, k) => [name, qslerp(quatAt(clip.GX, i * E + k), quatAt(clip.GX, j * E + k), u)]))
  const s: ClipSample = { G, hips: { x: lerp(clip.hips, 3, 0), y: lerp(clip.hips, 3, 1), z: lerp(clip.hips, 3, 2) }, root, clear: lerp(clip.clear, 1, 0), hipH: clip.hipH, X }
  return mirror ? mirrorSample(s) : s
}

const otherSide = (name: string): string => (name.startsWith('Left') ? name.replace('Left', 'Right') : name.startsWith('Right') ? name.replace('Right', 'Left') : name)

/** Left and right swapped through the body's midplane. */
export function mirrorSample(s: ClipSample): ClipSample {
  return {
    ...s,
    G: MIRROR.map((k) => reflect(s.G[k]!)),
    hips: { ...s.hips, x: -s.hips.x },
    root: { x: -s.root.x, z: s.root.z },
    X: new Map([...s.X].map(([name, q]) => [otherSide(name), reflect(q)]))
  }
}

/** The clip's root travel at clip time `t` (source rig metres). */
export function clipRoot(clip: MocapClip, t: number, mirror = false): { x: number; z: number } {
  return clipSample(clip, t, mirror).root
}

/** Source rig metres → a bot's metres: its hips height over the source's, times its height multiplier. */
export function clipScale(m: MocapDims, hipH: number): number {
  return (m.rig.rest[BONE_INDEX.Hips]!.y / hipH) * m.k
}

/** Each joint channel's rotation on the bone it turns (the torso in thirds, the head in halves). */
function overlayOf(L: RigLocals): (Quat | null)[] {
  const t = qpow(L.torso, 1 / 3)
  const h = qpow(L.head, 0.5)
  const by: Partial<Record<MocapBone, Quat>> = {
    Spine: t,
    Spine1: t,
    Spine2: t,
    Neck: h,
    Head: h,
    LeftArm: L.shoulderL,
    RightArm: L.shoulderR,
    LeftForeArm: L.elbowL,
    RightForeArm: L.elbowR,
    LeftUpLeg: L.hipL,
    RightUpLeg: L.hipR,
    LeftLeg: L.kneeL,
    RightLeg: L.kneeR
  }
  return MOCAP_BONES.map((b) => by[b] ?? null)
}

const hasChannels = (joints: Record<string, number> | undefined): joints is Record<string, number> =>
  !!joints && Object.values(joints).some((v) => v !== 0)

/** A pose from rig rotations and the hips joint (A-rest offsets down the hierarchy), the bones beyond the core too when `XG` is given. */
export function chain(m: MocapDims, G: Quat[], hips: V3, XG?: Quat[]): MocapPose {
  const P: V3[] = new Array(N)
  P[0] = hips
  for (let i = 1; i < N; i++) {
    const par = m.rig.parent[i]!
    P[i] = vadd(P[par]!, qrot(G[par]!, vscale(m.rig.offset[i]!, m.k)))
  }
  if (!XG) return { P, G }
  const XP: V3[] = new Array(m.rig.extra.length)
  m.rig.extra.forEach((x, e) => {
    const p = x.parent
    XP[e] = vadd(p < N ? P[p]! : XP[p - N]!, qrot(p < N ? G[p]! : XG[p - N]!, vscale(x.offset, m.k)))
  })
  return { P, G, XP, XG }
}

/**
 * The bones beyond the core for a pose: each turned by `local` (its rotation
 * under its parent's, by name: a hand pose) or riding its parent.
 */
export function withExtras(m: MocapDims, pose: MocapPose, local?: Map<string, Quat>): MocapPose {
  const XG: Quat[] = new Array(m.rig.extra.length)
  m.rig.extra.forEach((x, e) => {
    const gp = x.parent < N ? pose.G[x.parent]! : XG[x.parent - N]!
    const l = local?.get(x.name)
    XG[e] = l ? qmul(gp, l) : gp
  })
  return chain(m, pose.G, pose.P[0]!, XG)
}

/** A clip sample's bones beyond the core as rotations under their parents (a hand pose to put on any pose). */
export function sampleLocals(m: MocapDims, s: ClipSample): Map<string, Quat> {
  const out = new Map<string, Quat>()
  const world: Quat[] = new Array(m.rig.extra.length)
  m.rig.extra.forEach((x, e) => {
    const gp = x.parent < N ? s.G[x.parent]! : world[x.parent - N]!
    const g = s.X.get(x.name)
    world[e] = g ?? gp
    if (g) out.set(x.name, qmul(qconj(gp), g))
  })
  return out
}

/** A bot posed by a clip sample plus the overlay `joints` (not grounded: the hips at the clip's height). */
export function clipPose(m: MocapDims, s: ClipSample, joints?: Record<string, number>): MocapPose {
  let G = s.G
  if (hasChannels(joints)) {
    const L = jointLocals(joints)
    const ov = overlayOf(L)
    const out: Quat[] = new Array(N)
    out[0] = qmul(L.pelvis, G[0]!)
    for (let i = 1; i < N; i++) {
      const par = m.rig.parent[i]!
      const local = qmul(qconj(G[par]!), G[i]!)
      const o = ov[i]
      out[i] = qmul(out[par]!, o ? qmul(o, local) : local)
    }
    G = out
  }
  // The bones beyond the core keep the clip's rotation under their parent (riding it where the clip has none).
  const pose = chain(m, G, vscale(s.hips, clipScale(m, s.hipH)))
  return s.X.size > 0 ? withExtras(m, pose, sampleLocals(m, s)) : pose
}

/** Crossfade two poses of one bot: rotations on the shortest arc, the hips straight. */
export function blendPoses(m: MocapDims, a: MocapPose, b: MocapPose, w: number): MocapPose {
  if (w <= 0) return a
  if (w >= 1) return b
  const G = a.G.map((q, i) => qslerp(q, b.G[i]!, w))
  const h0 = a.P[0]!
  const h1 = b.P[0]!
  const hips = { x: h0.x + (h1.x - h0.x) * w, y: h0.y + (h1.y - h0.y) * w, z: h0.z + (h1.z - h0.z) * w }
  if (!a.XG && !b.XG) return chain(m, G, hips)
  // The bones beyond the core blend under their parents (a side without them rides its core bones).
  const la = extraLocals(m, a)
  const lb = extraLocals(m, b)
  const local = new Map(m.rig.extra.map((x, e) => [x.name, qslerp(la[e]!, lb[e]!, w)]))
  return withExtras(m, chain(m, G, hips), local)
}

/** Each bone beyond the core's rotation under its parent in a pose, by name (a hand pose). */
export function poseLocals(m: MocapDims, pose: MocapPose): Map<string, Quat> {
  const l = extraLocals(m, pose)
  return new Map(m.rig.extra.map((x, e) => [x.name, l[e]!]))
}

/** Each bone beyond the core's rotation under its parent in a pose (identity where it rides). */
function extraLocals(m: MocapDims, pose: MocapPose): Quat[] {
  return m.rig.extra.map((x, e) => {
    if (!pose.XG) return [0, 0, 0, 1]
    const gp = x.parent < N ? pose.G[x.parent]! : pose.XG[x.parent - N]!
    return qmul(qconj(gp), pose.XG[e]!)
  })
}

/** The lowest surface point of a posed bot (its support points, each on its own bone), entity-local. */
export function poseLowY(m: MocapDims, pose: MocapPose): number {
  let low = Infinity
  const k = m.k
  for (const pt of m.rig.points) {
    // A finger point rides its own bone when the pose turns the fingers.
    const sub = pose.XG && pt.sub !== undefined
    const [x, y, z, w] = sub ? pose.XG![pt.sub!]! : pose.G[pt.bone]!
    const o = sub ? pt.subOff! : pt.off
    // qrot's y, inline (the hot loop of every grounding).
    const tx = 2 * (y * o.z * k - z * o.y * k)
    const tz = 2 * (x * o.y * k - y * o.x * k)
    const py = (sub ? pose.XP![pt.sub!]! : pose.P[pt.bone]!).y + o.y * k + w * (2 * (z * o.x * k - x * o.z * k)) + z * tx - x * tz
    if (py < low) low = py
  }
  return low
}

/** The pose moved up or down so its lowest point is `clear` above the root. */
export function groundPose(m: MocapDims, pose: MocapPose, clear: number): MocapPose {
  const dy = clear - poseLowY(m, pose)
  const up = (p: V3): V3 => ({ x: p.x, y: p.y + dy, z: p.z })
  return pose.XP ? { P: pose.P.map(up), G: pose.G, XP: pose.XP.map(up), XG: pose.XG } : { P: pose.P.map(up), G: pose.G }
}

/**
 * A bot's pose for a clip state plus the overlay `joints`, grounded at the
 * (crossfaded) clearance; null when the clip isn't registered. A crossfade
 * from no clip starts from the rig pose of `joints`, grounded on the root.
 */
export function mocapClipPose(m: MocapDims, st: ClipState, joints?: Record<string, number>): MocapPose | null {
  const clip = CLIPS.get(st.id)
  if (!clip) return null
  const s = clipSample(clip, st.t, st.mirror)
  let pose = clipPose(m, s, joints)
  let clear = s.clear * clipScale(m, s.hipH)
  const w = Math.min(1, Math.max(0, st.w ?? 1))
  if (w < 1) {
    const fc = st.from ? CLIPS.get(st.from.id) : undefined
    let a: MocapPose
    let ca = 0
    if (fc && st.from) {
      const sa = clipSample(fc, st.from.t, st.from.mirror)
      a = clipPose(m, sa, joints)
      ca = sa.clear * clipScale(m, sa.hipH)
    } else a = mocapPose(m, jointLocals(joints))
    pose = blendPoses(m, a, pose, w)
    clear = ca + (clear - ca) * w
  }
  return groundPose(m, pose, clear)
}

/** A bot's frames for joints and an optional clip state (the body call, `skeleton.ts`). */
export function botFrames(m: MocapDims, joints: Record<string, number> | undefined, clip?: ClipState): PoseFrames {
  const pose = clip ? mocapClipPose(m, clip, joints) : null
  return poseFramesOf(m, pose ?? mocapPose(m, jointLocals(joints)))
}

export function botEffectors(m: MocapDims, joints: Record<string, number> | undefined, clip?: ClipState): Record<Effector, V3> {
  return effectorsOf(m, botFrames(m, joints, clip))
}
