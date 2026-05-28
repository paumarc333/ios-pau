import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const supabase = createClient(url, key)

export type Meal = {
  id: string
  created_at: string
  name: string
  calories: number
  protein: number
  carbs: number
  fat: number
}

export type JournalEntry = {
  id: string
  created_at: string
  date: string
  productivity: number
  energy: number
  mood: number
  overall: number
  thought1: string
  thought2: string
}
