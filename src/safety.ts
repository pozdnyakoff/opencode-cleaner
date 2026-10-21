import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { realpath, lstat, readdir, stat } from 'node:fs/promises'
import { join, isAbsolute, format, parse, basename, dirname } from 'node:path'

import type { Installation } from './discover.js'
import { contains } from './utils.js'

export interface Target {
  names: string[]
  path: string
  identity: {
    dev: number
    ino: number
  }
}

export async function getProtectedPaths(binary: string): Promise<string[]> {
  const paths = [
    homedir(),
    process.cwd(),
    binary,
    process.execPath,
    fileURLToPath(import.meta.url),
  ]

  return Promise.all(paths.map((path) => realpath(path)))
}

export async function plan(
  installation: Installation,
  protectedPaths: string[],
): Promise<Target[]> {
  const roots: Target[] = []

  for (const storage of installation.storage) {
    const target = await root(storage.path, installation.app, protectedPaths)

    if (target && (await hasData(target.path))) {
      roots.push({
        names: [storage.name],
        ...target,
      })
    }
  }

  roots.sort(
    (a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path),
  )

  const targets: Target[] = []

  for (const target of roots) {
    const parent = targets.find((parent) => contains(parent.path, target.path))

    if (parent) {
      parent.names.push(...target.names)
    } else {
      targets.push(target)
    }
  }

  return targets
}

export async function revalidate(
  targets: Target[],
  app: string,
  protectedPaths: string[],
  signal?: AbortSignal,
): Promise<void> {
  for (const target of targets) {
    signal?.throwIfAborted()

    const current = await root(target.path, app, protectedPaths)

    if (
      current?.path !== target.path ||
      current.identity.dev !== target.identity.dev ||
      current.identity.ino !== target.identity.ino
    ) {
      throw new Error(`Directory has changed: ${target.path}`)
    }
  }
}

export async function checkTree(
  path: string,
  device: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()

  const before = await lstat(path)

  if (before.dev !== device) {
    throw new Error(`Directory is a mount point: ${path}`)
  }

  if (!before.isDirectory()) {
    return
  }

  for (const entry of await readdir(path)) {
    await checkTree(join(path, entry), device, signal)
  }

  const after = await lstat(path)

  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    !after.isDirectory()
  ) {
    throw new Error(`Directory has changed: ${path}`)
  }
}

async function root(
  inputPath: string,
  app: string,
  protectedPaths: string[],
): Promise<Omit<Target, 'names'> | undefined> {
  if (!isAbsolute(inputPath) || /\p{Control}/u.test(inputPath)) {
    throw new Error('Path is invalid')
  }

  const input = format(parse(inputPath))

  const info = await lstat(input).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error
    }
  })

  if (!info) {
    return
  }

  if (!info.isDirectory()) {
    throw new Error(`Path is not a directory: ${inputPath}`)
  }

  const path = await realpath(input)

  if (/\p{Control}/u.test(path)) {
    throw new Error('Path is invalid')
  }

  if (protectedPaths.some((protectedPath) => contains(path, protectedPath))) {
    throw new Error(`Directory is protected: ${path}`)
  }

  if (basename(inputPath) !== app || basename(path) !== app) {
    throw new Error(`Directory must be named "${app}": ${path}`)
  }

  if ((await stat(dirname(path))).dev !== info.dev) {
    throw new Error(`Directory is a mount point: ${path}`)
  }

  return {
    path,
    identity: {
      dev: info.dev,
      ino: info.ino,
    },
  }
}

async function hasData(path: string): Promise<boolean> {
  const info = await lstat(path)

  if (!info.isDirectory()) {
    return info.size > 0
  }

  for (const entry of await readdir(path)) {
    if (await hasData(join(path, entry))) {
      return true
    }
  }

  return false
}
