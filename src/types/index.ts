import type { User } from '@supabase/supabase-js'

export interface AuthenticatedContext {
  user: User
  role: string
  userId: string
  token: string
}

export interface WebhookContext {
  webhookPayload: {
    event: string
    data: Record<string, unknown>
  } | null
}

export interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
}
