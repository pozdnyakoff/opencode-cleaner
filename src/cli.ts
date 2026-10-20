#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import confirm from '@inquirer/confirm'
import { styleText, stripVTControlCharacters } from 'node:util'

import { executable } from './command.js'
import { discover } from './discover.js'
import { getProtectedPaths, plan } from './safety.js'
import { clean } from './clean.js'
import { formatError } from './utils.js'

const controller = new AbortController()

main().catch((error) => {
  const cancelled =
    error.name === 'ExitPromptError' || error === controller.signal.reason

  const text = cancelled ? 'Cleanup cancelled' : formatError(error)

  const message = stripVTControlCharacters(text).replace(
    /(?![\t\n])\p{Control}/gu,
    '',
  )

  console.error(message)

  process.exitCode = cancelled || controller.signal.aborted ? 130 : 1
})

async function main(): Promise<void> {
  const { version } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  )

  yargs(hideBin(process.argv))
    .scriptName('opencode-cleaner')
    .usage('$0 [options]')
    .version(version)
    .alias('version', 'v')
    .alias('help', 'h')
    .strict()
    .demandCommand(0, 0)
    .showHelpOnFail(false)
    .parseSync()

  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error('An interactive terminal is required')
  }

  const installation = await discover(await executable())
  const protectedPaths = await getProtectedPaths(installation.binary)
  const targets = await plan(installation, protectedPaths)

  if (!targets.length) {
    console.log('No OpenCode data found')

    return
  }

  const width = Math.max(
    ...targets.map((target) => target.names.join(', ').length),
  )

  const rows = targets.map((target) => {
    const label = target.names.join(', ').padEnd(width)

    return `  ${styleText('dim', label)}  ${target.path}`
  })

  console.log(`${rows.join('\n')}\n`)

  const answer = await confirm({
    message: 'Delete these directories?',
    default: false,
  })

  if (!answer) {
    console.log('Cleanup cancelled')

    return
  }

  process.on('SIGINT', () => controller.abort())

  await clean(installation, targets, protectedPaths, controller.signal)
  console.log('OpenCode data cleared')
}
