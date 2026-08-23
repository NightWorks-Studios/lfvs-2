import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type { Request } from '@cordisjs/plugin-server'

export type PowProfile = 'light' | 'normal' | 'bulk'
export type IpBinding = 'exact' | 'prefix' | 'none'

export interface ChallengePayload {
  version: 1
  id: string
  bootId: string
  issuedAt: number
  expiresAt: number
  method: string
  requestHash: string
  clientHash: string
  difficulty: number
  profile: PowProfile
}

export function randomId() {
  return randomBytes(16).toString('base64url')
}

export function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest()
}

export function sha256Base64Url(value: string | Buffer) {
  return sha256(value).toString('base64url')
}

export function hmacBase64Url(secret: Buffer, value: string) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

export function signChallenge(secret: Buffer, payload: ChallengePayload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${hmacBase64Url(secret, encoded)}`
}

export function parseAndVerifyChallenge(secret: Buffer, token: string): ChallengePayload | null {
  if (token.length > 2048) return null
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  const expected = Buffer.from(hmacBase64Url(secret, parts[0]), 'base64url')
  let actual: Buffer
  try {
    actual = Buffer.from(parts[1], 'base64url')
  } catch {
    return null
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
  try {
    return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as ChallengePayload
  } catch {
    return null
  }
}

export function canonicalRequest(req: Request) {
  const query = [...req.query.entries()].sort(([aKey, aValue], [bKey, bValue]) => {
    return aKey.localeCompare(bKey) || aValue.localeCompare(bValue)
  })
  return `${req.method.toUpperCase()}\n${req.path}\n${new URLSearchParams(query).toString()}`
}

export function requestHash(req: Request) {
  return sha256Base64Url(canonicalRequest(req))
}

export function requestAddress(req: Request, trustProxy: boolean) {
  const forwarded = trustProxy ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined
  return normalizeAddress(forwarded || req._req.socket.remoteAddress || 'unknown')
}

export function addressBinding(address: string, mode: IpBinding, ipv4Prefix: number, ipv6Prefix: number) {
  if (mode === 'none' || address === 'unknown') return 'none'
  if (mode === 'exact') return address
  const version = isIP(address)
  if (version === 4) return `${maskBytes(ipv4Bytes(address), ipv4Prefix).toString('hex')}/${ipv4Prefix}`
  if (version === 6) return `${maskBytes(ipv6Bytes(address), ipv6Prefix).toString('hex')}/${ipv6Prefix}`
  return address
}

export function countLeadingZeroBits(value: Buffer) {
  let count = 0
  for (const byte of value) {
    if (byte === 0) {
      count += 8
      continue
    }
    count += Math.clz32(byte) - 24
    break
  }
  return count
}

export function verifyWork(token: string, nonce: string, difficulty: number) {
  if (!/^[0-9a-fA-F]{1,32}$/.test(nonce)) return false
  return countLeadingZeroBits(sha256(`${token}.${nonce.toLowerCase()}`)) >= difficulty
}

function normalizeAddress(address: string) {
  const withoutZone = address.split('%')[0].toLowerCase()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(withoutZone)
  return mapped ? mapped[1] : withoutZone
}

function ipv4Bytes(address: string) {
  return Buffer.from(address.split('.').map(Number))
}

function ipv6Bytes(address: string) {
  let source = address
  const ipv4Match = /(\d+\.\d+\.\d+\.\d+)$/.exec(source)
  if (ipv4Match) {
    const bytes = ipv4Bytes(ipv4Match[1])
    source = source.slice(0, -ipv4Match[1].length) + `${bytes.readUInt16BE(0).toString(16)}:${bytes.readUInt16BE(2).toString(16)}`
  }
  const [leftSource, rightSource = ''] = source.split('::')
  const left = leftSource ? leftSource.split(':') : []
  const right = rightSource ? rightSource.split(':') : []
  const missing = 8 - left.length - right.length
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right]
  const result = Buffer.alloc(16)
  groups.slice(0, 8).forEach((group, index) => result.writeUInt16BE(Number.parseInt(group || '0', 16), index * 2))
  return result
}

function maskBytes(input: Buffer, prefix: number) {
  const output = Buffer.from(input)
  const completeBytes = Math.floor(prefix / 8)
  const remainingBits = prefix % 8
  if (remainingBits && completeBytes < output.length) output[completeBytes] &= 0xff << (8 - remainingBits)
  const start = completeBytes + (remainingBits ? 1 : 0)
  output.fill(0, start)
  return output
}
