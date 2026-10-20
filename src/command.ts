import which from 'which'
import { realpath } from 'node:fs/promises'
import { execa } from 'execa'

export async function executable(): Promise<string> {
  const binary = await which('opencode', { nothrow: true })

  if (!binary) {
    throw new Error('OpenCode executable not found in PATH')
  }

  return realpath(binary)
}

export async function run(
  file: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await execa(file, args, {
    ...(signal && { cancelSignal: signal }),
  })

  return stdout
}
