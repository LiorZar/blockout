/**
 * Fork (fix-env): the date-time stamp in export folder and file names, in the
 * local wall-clock time the user sees (toISOString() stamped UTC).
 */

const pad = (n: number): string => String(n).padStart(2, '0')

/** `YYYY-MM-DD-HH-mm-ss` in local time. */
export function exportStamp(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  )
}
