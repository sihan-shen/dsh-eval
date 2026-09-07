import { get_encoding } from '@dqbd/tiktoken'

const TOKENIZER_NAME = '@dqbd/tiktoken' as const
const TOKENIZER_ENCODING = 'cl100k_base' as const
const TOKENIZER_VERSION = '1.0.22' as const

export function estimateSourceTokensV1(text: string): number {
  if (typeof text !== 'string') throw new TypeError('text must be a string')
  const encoding = get_encoding(TOKENIZER_ENCODING)
  try {
    return encoding.encode(text).length
  } finally {
    encoding.free()
  }
}

export const tokenizerMetadataV1 = {
  tokenizer_name: TOKENIZER_NAME,
  tokenizer_encoding: TOKENIZER_ENCODING,
  tokenizer_version: TOKENIZER_VERSION,
} as const
