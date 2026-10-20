import { createHash } from 'node:crypto'
import { getSystemErrorMessage } from 'node:util'
import { relative, isAbsolute, sep } from 'node:path'

export const hash = (buffer: Buffer): string =>
  createHash('sha256').update(buffer).digest('hex')

export function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }

  const { errno, path } = error as NodeJS.ErrnoException

  if (typeof errno === 'number' && errno < 0 && path) {
    const reason = getSystemErrorMessage(errno)

    return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}: ${path}`
  }

  return error.message
}

export function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child)

  return (
    difference === '' ||
    (!isAbsolute(difference) &&
      difference !== '..' &&
      !difference.startsWith(`..${sep}`))
  )
}
