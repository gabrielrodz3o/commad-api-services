import { query } from './pool.js'

export interface AccountingAccountHit {
  id: number
  code: string
  name: string
}

export interface ManualJournalConfig {
  diary_type_id: number
  currency_id: number
  currency_code: string
}

export async function findAccountingAccounts(businessUnitId: number, term: string): Promise<AccountingAccountHit[]> {
  const value = String(term || '').trim()
  if (!value) return []
  return query<AccountingAccountHit>(
    `SELECT id,code,name
       FROM finances.chart_of_accounts
      WHERE business_unit_id=$1 AND active AND is_posteable
        AND (code=$2 OR lower(name)=lower($2) OR name ILIKE '%' || $2 || '%'
          OR ($3::int IS NOT NULL AND id=$3))
      ORDER BY CASE WHEN code=$2 THEN 0 WHEN lower(name)=lower($2) THEN 1 ELSE 2 END,code
      LIMIT 6`,
    [businessUnitId, value, /^\d+$/.test(value) ? Number(value) : null],
  )
}

export async function getManualJournalConfig(businessUnitId: number): Promise<ManualJournalConfig | null> {
  const rows = await query<ManualJournalConfig>(
    `SELECT dt.id AS diary_type_id,bu.currency_id,cur.code AS currency_code
       FROM human_resource.business_units bu
       JOIN human_resource.currencies cur ON cur.id=bu.currency_id
       CROSS JOIN LATERAL (
         SELECT id FROM finances.diary_book_types WHERE code='ED' ORDER BY id LIMIT 1
       ) dt
      WHERE bu.id=$1`,
    [businessUnitId],
  )
  return rows[0] || null
}
