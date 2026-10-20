import { rm } from 'node:fs/promises'

import { verifyBinary, type Installation } from './discover.js'
import { run } from './command.js'
import { revalidate, checkTree, type Target } from './safety.js'
import { formatError } from './utils.js'

export async function clean(
  installation: Installation,
  targets: Target[],
  protectedPaths: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted()
  await verifyBinary(installation)
  signal?.throwIfAborted()

  try {
    await run(installation.binary, ['service', 'stop'], signal)
  } catch {
    signal?.throwIfAborted()

    throw new Error('Cannot stop OpenCode service')
  }

  await verifyBinary(installation)

  return removeTargets(installation, targets, protectedPaths, signal)
}

export async function removeTargets(
  installation: Installation,
  targets: Target[],
  protectedPaths: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted()
  await revalidate(targets, installation.app, protectedPaths, signal)

  for (const target of targets) {
    await checkTree(target.path, target.identity.dev, signal)
  }

  const removed: string[] = []

  try {
    for (const target of targets) {
      await revalidate([target], installation.app, protectedPaths, signal)
      signal?.throwIfAborted()
      await rm(target.path, { recursive: true })
      removed.push(target.path)
    }

    signal?.throwIfAborted()
  } catch (err) {
    let message: string

    if (signal?.aborted && err === signal.reason) {
      message = 'Cleanup cancelled'
    } else {
      message = formatError(err)
    }

    if (removed.length) {
      if (message) {
        message += '\n'
      }

      message += `Deleted directories: ${removed.join(', ')}`
    }

    throw new Error(message)
  }

  return removed
}
