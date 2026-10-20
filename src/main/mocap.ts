/**
 * Mocap library IPC (fork addition; see MODIFICATIONS.md): `mocap:list`
 * returns the local Mixamo library's manifest (null without one), and
 * `mocap:read` returns one of its files. Reads are confined to the library
 * folder, as `file:readAbsolute` is to the project.
 */

import { ipcMain } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { mocapLibraryDir, mocapLibraryPath, parseMocapManifest } from '../shared/mocap-library'

export function registerMocapIpc(): void {
  ipcMain.handle('mocap:list', async () => {
    try {
      return parseMocapManifest(JSON.parse(await readFile(join(mocapLibraryDir(), 'manifest.json'), 'utf-8')))
    } catch {
      return null
    }
  })
  ipcMain.handle('mocap:read', async (_e, relativePath: string) => {
    const full = mocapLibraryPath(mocapLibraryDir(), relativePath)
    if (!full) throw new Error('path escapes the mocap library')
    const data = await readFile(full)
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  })
}
