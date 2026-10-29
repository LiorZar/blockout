/**
 * The shared camera-move table (fork addition, shared-camera-moves; see
 * MODIFICATIONS.md): `camera-moves.json` is a byte-identical copy of Ebook
 * Studio's `desktop/src/shared/camera/camera-moves.json`, so a move's id is
 * the same word in both apps. Ebook's blockout brief sends it as
 * `camera.movement` and `apply_camera_move` takes it as `presetId`.
 *
 * Never edit the JSON here: change it in Ebook, then copy it over (Ebook's
 * contract test compares the two files).
 *
 * `blockout` says how Blockout stages a move: `preset` builds a camera path,
 * `rig` sets a camera rig, `prompt` only records the move for the prompt.
 *
 * PURE: no DOM / three.js / Electron.
 */

import table from './camera-moves.json'

export type SharedMoveId = string

export type BlockoutSupport = 'preset' | 'rig' | 'prompt'

export interface SharedMove {
  id: SharedMoveId
  name: string
  category: string
  blockout: BlockoutSupport
  /** One sentence about the camera only; a speed-able move carries `{speed}`. */
  prompt: string
  speedable: boolean
}

interface SharedMoveTable {
  version: number
  categories: { id: string; name: string }[]
  moves: Omit<SharedMove, 'speedable'>[]
}

const SPEED_TOKEN = '{speed}'
const TABLE = table as SharedMoveTable

export const SHARED_MOVES_VERSION: number = TABLE.version

export const SHARED_MOVE_CATEGORIES: readonly { id: string; name: string }[] = TABLE.categories

export const SHARED_MOVES: readonly SharedMove[] = TABLE.moves.map((m) => ({ ...m, speedable: m.prompt.includes(SPEED_TOKEN) }))

const BY_ID = new Map(SHARED_MOVES.map((m) => [m.id, m]))

export function sharedMove(id: string): SharedMove | undefined {
  return BY_ID.get(id)
}

/** The move's prompt sentence without a speed word: Blockout has no speed field (the shot's length is the speed). */
export function sharedMoveSentence(id: string): string {
  const move = BY_ID.get(id)
  return move ? move.prompt.replace(`${SPEED_TOKEN} `, '') : ''
}
