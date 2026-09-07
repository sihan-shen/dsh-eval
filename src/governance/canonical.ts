import { createHash } from 'node:crypto'

const MAX_CANONICAL_BYTES = 16_777_216
const MAX_DEPTH = 32
const MAX_NODES = 1_048_576
const MAX_OWN_FIELDS = 32
const MAX_STRING_BYTES = 128
const encoder = new TextEncoder()

function fail(message: string): never {
  throw new TypeError(`governance canonical value ${message}`)
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertWellFormedString(value: string, kind: 'string' | 'key'): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        fail(`${kind} must contain well-formed Unicode`)
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`${kind} must contain well-formed Unicode`)
    }
  }
  if (encoder.encode(value).byteLength > MAX_STRING_BYTES) {
    fail(`${kind} exceeds the bounded UTF-8 length`)
  }
}

function assertDataProperty(
  descriptor: PropertyDescriptor | undefined,
): PropertyDescriptor & { value: unknown } {
  if (!descriptor) fail('missing property')
  if (!('value' in descriptor)) fail('accessor property is not allowed')
  if (!descriptor.enumerable) fail('non-enumerable property is not allowed')
  return descriptor as PropertyDescriptor & { value: unknown }
}

function assertNoSymbols(value: object): void {
  if (Object.getOwnPropertySymbols(value).length !== 0) fail('must not contain symbol keys')
}

function isCanonicalArrayIndex(property: string): boolean {
  const index = Number(property)
  return Number.isInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === property
}

class CanonicalWriter {
  private readonly chunks: string[] = []
  private byteLength = 0

  write(value: string): void {
    const bytes = encoder.encode(value).byteLength
    if (bytes > MAX_CANONICAL_BYTES - this.byteLength) fail('exceeds the bounded canonical byte length')
    this.chunks.push(value)
    this.byteLength += bytes
  }

  toString(): string {
    return this.chunks.join('')
  }
}

function canonicalize(
  value: unknown,
  writer: CanonicalWriter,
  seen: WeakSet<object>,
  depth: number,
  state: { nodes: number },
): void {
  state.nodes += 1
  if (state.nodes > MAX_NODES) fail('exceeds the bounded node count')

  if (value === null || typeof value === 'boolean') {
    writer.write(JSON.stringify(value))
    return
  }
  if (typeof value === 'string') {
    assertWellFormedString(value, 'string')
    writer.write(JSON.stringify(value))
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail('number must be finite and not negative zero')
    writer.write(JSON.stringify(value))
    return
  }
  if (typeof value !== 'object' || value === null) fail('must be a JSON value')
  if (seen.has(value)) fail('must not be cyclic')
  if (depth >= MAX_DEPTH) fail('exceeds the bounded nesting depth')
  if (Array.isArray(value)) {
    assertNoSymbols(value)
    const length = value.length
    if (!Number.isSafeInteger(length) || length > MAX_NODES) fail('array length is out of bounds')
    const ownProperties = Object.getOwnPropertyNames(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || !('value' in lengthDescriptor)) fail('array length must be a data property')
    const descriptors = new Map<string, PropertyDescriptor & { value: unknown }>()
    for (const property of ownProperties) {
      if (property === 'length') continue
      if (!isCanonicalArrayIndex(property) || Number(property) >= length) {
        fail('invalid array property')
      }
      descriptors.set(property, assertDataProperty(Object.getOwnPropertyDescriptor(value, property)))
    }
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, String(index))) fail(`array is sparse at index ${index}`)
    }

    seen.add(value)
    writer.write('[')
    for (let index = 0; index < length; index += 1) {
      if (index !== 0) writer.write(',')
      canonicalize(descriptors.get(String(index))!.value, writer, seen, depth + 1, state)
    }
    writer.write(']')
    seen.delete(value)
    return
  }

  if (!isPlainRecord(value)) fail('must be a plain JSON value')
  assertNoSymbols(value)
  const ownProperties = Object.getOwnPropertyNames(value)
  if (ownProperties.length > MAX_OWN_FIELDS) fail('exceeds the bounded field count')
  const descriptors = new Map<string, PropertyDescriptor & { value: unknown }>()
  for (const property of ownProperties) {
    assertWellFormedString(property, 'key')
    descriptors.set(property, assertDataProperty(Object.getOwnPropertyDescriptor(value, property)))
  }

  seen.add(value)
  writer.write('{')
  for (const [index, property] of ownProperties.sort().entries()) {
    if (index !== 0) writer.write(',')
    writer.write(JSON.stringify(property))
    writer.write(':')
    canonicalize(descriptors.get(property)!.value, writer, seen, depth + 1, state)
  }
  writer.write('}')
  seen.delete(value)
}

export function canonicalGovernanceJson(value: unknown): string {
  const writer = new CanonicalWriter()
  canonicalize(value, writer, new WeakSet<object>(), 0, { nodes: 0 })
  return writer.toString()
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalGovernanceJson(value), 'utf8').digest('hex')
}
