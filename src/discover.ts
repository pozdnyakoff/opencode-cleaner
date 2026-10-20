import { readFile } from 'node:fs/promises'
import { parse, type Property } from 'acorn'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

import { hash } from './utils.js'
import { run } from './command.js'

export interface Storage {
  name: string
  path: string
}

export interface Installation {
  binary: string
  digest: string
  app: string
  storage: Storage[]
}

const unsupported = () => new Error('Cannot determine OpenCode directories')

export async function discover(binary: string): Promise<Installation> {
  const buffer = await readFile(binary)
  const { app, fields } = extractStorage(buffer)

  const installation: Installation = {
    binary,
    digest: hash(buffer),
    app,
    storage: [],
  }

  for (const name of fields) {
    let path

    try {
      path = await run(binary, ['debug', 'paths', name])
    } catch {
      throw new Error('Cannot read OpenCode paths')
    }

    installation.storage.push({
      name,
      path,
    })
  }

  await verifyBinary(installation)

  return installation
}

export function extractStorage(buffer: Buffer): {
  app: string
  fields: string[]
} {
  const chunks = new Set<string>()
  const marker = Buffer.from('@opencode/Global')

  for (
    let offset = 0;
    (offset = buffer.indexOf(marker, offset)) !== -1;
    offset += marker.length
  ) {
    const start = buffer.lastIndexOf(0, offset) + 1
    const end = buffer.indexOf(0, offset)

    if (end < start) {
      continue
    }

    const source = buffer.subarray(start, end).toString()

    if (source.startsWith('// @bun')) {
      chunks.add(source)
    }
  }

  if (chunks.size !== 1) {
    throw unsupported()
  }

  let ast

  try {
    ast = parse([...chunks][0]!, {
      ecmaVersion: 'latest',
      sourceType: 'module',
    })
  } catch {
    throw unsupported()
  }

  const declarations = ast.body.flatMap((statement) =>
    statement.type === 'VariableDeclaration' ? statement.declarations : [],
  )

  const functions = ast.body.filter(
    (statement) => statement.type === 'FunctionDeclaration',
  )

  const pathImports = ast.body.flatMap((statement) => {
    if (
      statement.type !== 'ImportDeclaration' ||
      !['path', 'node:path'].includes(String(statement.source.value))
    ) {
      return []
    }

    return statement.specifiers
      .filter((specifier) => specifier.type !== 'ImportSpecifier')
      .map((specifier) => specifier.local.name)
  })

  const candidates: {
    app: string
    fields: string[]
  }[] = []

  for (const declaration of declarations) {
    if (
      declaration.id.type !== 'ObjectPattern' ||
      declaration.init?.type !== 'CallExpression'
    ) {
      continue
    }

    const call = declaration.init

    if (call.callee.type !== 'Identifier' || call.arguments.length !== 1) {
      continue
    }

    const argument = call.arguments[0]

    const value =
      argument?.type === 'Identifier'
        ? declarations.find(
            (item) =>
              item.id.type === 'Identifier' && item.id.name === argument.name,
          )?.init
        : argument

    if (value?.type !== 'Literal' || value.value !== 'opencode') {
      continue
    }

    const app = value.value
    const factoryName = call.callee.name
    const factory = functions.find((item) => item.id?.name === factoryName)

    if (
      !factory ||
      factory.async ||
      factory.generator ||
      factory.params.length !== 1 ||
      factory.params[0]?.type !== 'Identifier'
    ) {
      continue
    }

    if (factory.body.body.length !== 1) {
      throw unsupported()
    }

    const returned = factory.body.body[0]

    if (
      returned?.type !== 'ReturnStatement' ||
      returned.argument?.type !== 'ObjectExpression'
    ) {
      throw unsupported()
    }

    const parameter = factory.params[0].name

    const fields = returned.argument.properties.map((property) => {
      if (property.type !== 'Property') {
        throw unsupported()
      }

      const value = property.value

      if (
        value.type !== 'CallExpression' ||
        value.arguments.length !== 2 ||
        value.callee.type !== 'MemberExpression'
      ) {
        throw unsupported()
      }

      const callee = value.callee

      if (
        callee.computed ||
        callee.object.type !== 'Identifier' ||
        !pathImports.includes(callee.object.name) ||
        callee.property.type !== 'Identifier' ||
        callee.property.name !== 'join' ||
        value.arguments[1]?.type !== 'Identifier' ||
        value.arguments[1].name !== parameter
      ) {
        throw unsupported()
      }

      return getPropertyName(property)
    })

    if (!fields.length || new Set(fields).size !== fields.length) {
      throw unsupported()
    }

    candidates.push({
      app,
      fields,
    })
  }

  if (candidates.length !== 1) {
    throw unsupported()
  }

  return candidates[0]!
}

export async function verifyBinary(
  installation: Pick<Installation, 'binary' | 'digest'>,
): Promise<void> {
  const hash = createHash('sha256')

  for await (const chunk of createReadStream(installation.binary)) {
    hash.update(chunk)
  }

  if (hash.digest('hex') !== installation.digest) {
    throw new Error('OpenCode executable has changed')
  }
}

function getPropertyName(property: Property): string {
  if (property.computed || property.kind !== 'init' || property.method) {
    throw unsupported()
  }

  let name: unknown

  if (property.key.type === 'Identifier') {
    name = property.key.name
  } else if (property.key.type === 'Literal') {
    name = property.key.value
  }

  if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(name)) {
    throw unsupported()
  }

  return name
}
