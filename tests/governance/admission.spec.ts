import { describe, expect, it } from 'vitest'
import {
  canonicalGovernanceJson,
  parseCanonicalGovernanceJson,
} from '../../src/governance/index.js'

const encoder = new TextEncoder()

function bytes(value: string): Uint8Array {
  return encoder.encode(value)
}

describe('raw canonical governance admission', () => {
  it('admits only exact canonical UTF-8 bytes', () => {
    const input = bytes('{"a":1,"nested":{"b":true},"text":"é"}')

    expect(parseCanonicalGovernanceJson(input)).toEqual({
      a: 1,
      nested: { b: true },
      text: 'é',
    })
    expect(canonicalGovernanceJson({ text: 'é', nested: { b: true }, a: 1 }))
      .toBe('{"a":1,"nested":{"b":true},"text":"é"}')
  })

  it.each([
    ['fatal UTF-8', new Uint8Array([0x22, 0xc3, 0x28, 0x22])],
    ['BOM', new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])],
    ['leading whitespace', bytes(' {}')],
    ['trailing whitespace', bytes('{} ')],
    ['trailing newline', bytes('{}\n')],
    ['trailing bytes', bytes('{}{}')],
    ['duplicate keys', bytes('{"a":1,"a":1}')],
    ['alternate number spelling', bytes('{"a":1.0}')],
    ['alternate string spelling', bytes('{"a":"\\u0061"}')],
    ['lone surrogate', bytes('{"a":"\\ud800"}')],
  ])('rejects %s', (_name, input) => {
    expect(() => parseCanonicalGovernanceJson(input)).toThrowError(TypeError)
  })

  it('rejects a value that is valid JSON but not a single canonical value', () => {
    expect(() => parseCanonicalGovernanceJson(bytes('null\n')))
      .toThrow('governance admission non-canonical bytes')
  })

  it('rejects excessive nesting during bounded structural preflight', () => {
    const nested = `${'['.repeat(33)}0${']'.repeat(33)}`

    expect(() => parseCanonicalGovernanceJson(bytes(nested)))
      .toThrow('governance admission structure')
  })

  it('does not invoke getters or toJSON during object canonicalization', () => {
    let getterCalls = 0
    let toJsonCalls = 0
    const value = {
      toJSON: () => {
        toJsonCalls += 1
        return 'must not run'
      },
    }
    Object.defineProperty(value, 'secret', {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return 'must not run'
      },
    })

    expect(() => canonicalGovernanceJson(value)).toThrow('accessor')
    expect(getterCalls).toBe(0)
    expect(toJsonCalls).toBe(0)
  })
})
