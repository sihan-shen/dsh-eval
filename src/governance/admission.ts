import { canonicalGovernanceJson } from './canonical.js'

const MAX_CANONICAL_BYTES = 16_777_216
const MAX_DEPTH = 32
const MAX_NODES = 1_048_576
const MAX_OWN_FIELDS = 32
const MAX_STRING_BYTES = 128
const MAX_STRING_SOURCE_CHARS = MAX_STRING_BYTES * 6 + 2
const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

function fail(
  code: 'byte-length' | 'utf8' | 'json' | 'structure' | 'canonical' | 'non-canonical bytes',
): never {
  throw new TypeError(`governance admission ${code}`)
}

function skipWhitespace(source: string, index: number): number {
  while (index < source.length) {
    const code = source.charCodeAt(index)
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break
    index += 1
  }
  return index
}

function scanString(source: string, start: number): number {
  let escaped = false
  for (let index = start + 1; index < source.length; index += 1) {
    const code = source.charCodeAt(index)
    if (code < 0x20 && !escaped) fail('json')
    if (escaped) {
      escaped = false
      continue
    }
    if (code === 0x5c) {
      escaped = true
      continue
    }
    if (code !== 0x22) continue

    const end = index + 1
    if (end - start > MAX_STRING_SOURCE_CHARS) fail('structure')
    let value: unknown
    try {
      value = JSON.parse(source.slice(start, end)) as unknown
    } catch {
      fail('json')
    }
    if (typeof value !== 'string' || encoder.encode(value).byteLength > MAX_STRING_BYTES) {
      fail('structure')
    }
    return end
  }
  if (source.length - start > MAX_STRING_SOURCE_CHARS) fail('structure')
  fail('json')
}

function scanPrimitive(source: string, start: number): number {
  let index = start
  while (index < source.length) {
    const code = source.charCodeAt(index)
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d ||
        code === 0x2c || code === 0x5d || code === 0x7d) {
      break
    }
    index += 1
  }
  if (index === start) fail('json')
  return index
}

function scanValue(
  source: string,
  start: number,
  depth: number,
  state: { nodes: number },
): number {
  const index = skipWhitespace(source, start)
  if (index >= source.length) fail('json')
  state.nodes += 1
  if (state.nodes > MAX_NODES) fail('structure')

  const code = source.charCodeAt(index)
  if (code === 0x7b) return scanObject(source, index, depth, state)
  if (code === 0x5b) return scanArray(source, index, depth, state)
  if (code === 0x22) return scanString(source, index)
  if (code === 0x2c || code === 0x3a || code === 0x5d || code === 0x7d) fail('json')
  return scanPrimitive(source, index)
}

function scanObject(
  source: string,
  start: number,
  depth: number,
  state: { nodes: number },
): number {
  if (depth >= MAX_DEPTH) fail('structure')
  let index = skipWhitespace(source, start + 1)
  if (source.charCodeAt(index) === 0x7d) return index + 1

  let fields = 0
  while (true) {
    if (source.charCodeAt(index) !== 0x22) fail('json')
    fields += 1
    if (fields > MAX_OWN_FIELDS) fail('structure')
    index = scanString(source, index)
    index = skipWhitespace(source, index)
    if (source.charCodeAt(index) !== 0x3a) fail('json')
    index = scanValue(source, index + 1, depth + 1, state)
    index = skipWhitespace(source, index)
    if (source.charCodeAt(index) === 0x7d) return index + 1
    if (source.charCodeAt(index) !== 0x2c) fail('json')
    index = skipWhitespace(source, index + 1)
  }
}

function scanArray(
  source: string,
  start: number,
  depth: number,
  state: { nodes: number },
): number {
  if (depth >= MAX_DEPTH) fail('structure')
  let index = skipWhitespace(source, start + 1)
  if (source.charCodeAt(index) === 0x5d) return index + 1

  while (true) {
    index = scanValue(source, index, depth + 1, state)
    index = skipWhitespace(source, index)
    if (source.charCodeAt(index) === 0x5d) return index + 1
    if (source.charCodeAt(index) !== 0x2c) fail('json')
    index = skipWhitespace(source, index + 1)
  }
}

function preflightStructure(source: string): void {
  const end = scanValue(source, 0, 0, { nodes: 0 })
  if (skipWhitespace(source, end) !== source.length) fail('json')
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function parseCanonicalGovernanceJson(input: Uint8Array): unknown {
  if (!(input instanceof Uint8Array) || input.byteLength > MAX_CANONICAL_BYTES) {
    fail('byte-length')
  }

  let source: string
  try {
    source = decoder.decode(input)
  } catch {
    fail('utf8')
  }

  preflightStructure(source)

  let value: unknown
  try {
    value = JSON.parse(source) as unknown
  } catch {
    fail('json')
  }

  let canonical: string
  try {
    canonical = canonicalGovernanceJson(value)
  } catch {
    fail('canonical')
  }

  if (!equalBytes(input, encoder.encode(canonical))) fail('non-canonical bytes')
  return value
}
