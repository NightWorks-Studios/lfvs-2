import type { Router } from '@cordisjs/client'

export function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function formatMetric(value: string | number | null | undefined) {
  if (value === null || value === undefined) return '-'
  const text = String(value)
  if (!/^-?\d+$/.test(text)) return text
  const negative = text.startsWith('-')
  const digits = negative ? text.slice(1) : text
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return negative ? `-${grouped}` : grouped
}

export function formatTime(value: number | null | undefined) {
  if (!value) return '-'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(value)
}

export function formatDuration(value: number | null | undefined) {
  if (value === null || value === undefined) return '-'
  const total = Math.max(0, Math.round(value))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total % 3600 / 60)
  const seconds = total % 60
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function resourcePath(row: { platform: string; kind: string; id: string }) {
  return `/lfvs/resources/${encodeURIComponent(row.platform)}/${encodeURIComponent(row.kind)}/${encodeURIComponent(row.id)}`
}

export function authorPath(row: { platform: string; id: string }) {
  return `/lfvs/authors/${encodeURIComponent(row.platform)}/${encodeURIComponent(row.id)}`
}

export function openResource(router: Router, row: { platform: string; kind: string; id: string }) {
  return router.push(resourcePath(row))
}

export function openAuthor(router: Router, row: { platform: string; id: string }) {
  return router.push(authorPath(row))
}

export function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
