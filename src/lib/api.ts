// API client mock for static deployment

export const API_BASE = '/api'

export interface DailyStats {
  date: string
  cbz_count: number
  pdf_count: number
}

export interface Stats {
  pending: { cbz: number; pdf: number }
  totals: { cbz: number; pdf: number; total: number }
  daily: DailyStats[]
}

export async function getStats(days = 30): Promise<Stats> {
  // Return dummy stats
  return {
    pending: { cbz: 0, pdf: 0 },
    totals: { cbz: 0, pdf: 0, total: 0 },
    daily: []
  }
}

export async function recordConversion(type: 'cbz' | 'pdf'): Promise<void> {
  // No-op for static site
}

export async function healthCheck(): Promise<{
  status: string
  uptime: number
  pending: { cbz: number; pdf: number }
}> {
  return {
    status: 'ok',
    uptime: 0,
    pending: { cbz: 0, pdf: 0 }
  }
}
