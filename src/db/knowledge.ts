// CRUD + búsqueda semántica de la base de conocimiento (comandi.knowledge).
// La similitud (coseno) se calcula en JS sobre los embeddings de la empresa.
import { query } from './pool.js'
import { cosine } from '../context/embeddings.js'

export async function addKnowledge(businessUnitId: number, title: string | null, content: string, embedding: number[], userId: number | null): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO comandi.knowledge (business_unit_id, title, content, embedding, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [businessUnitId, title, content, embedding, userId],
  )
  return rows[0].id
}

export async function listKnowledge(businessUnitId: number): Promise<any[]> {
  return query(
    `SELECT id, title, left(content, 140) AS preview, created_at
       FROM comandi.knowledge WHERE business_unit_id = $1 ORDER BY created_at DESC`,
    [businessUnitId],
  )
}

export async function deleteKnowledge(businessUnitId: number, id: string): Promise<void> {
  await query('DELETE FROM comandi.knowledge WHERE id = $1 AND business_unit_id = $2', [id, businessUnitId])
}

interface KRow { id: string; title: string | null; content: string; embedding: number[] }

/** Top-k documentos más parecidos a la pregunta (coseno en JS). */
export async function searchKnowledge(businessUnitId: number, queryEmbedding: number[], k = 4): Promise<{ id: string; title: string | null; content: string; score: number }[]> {
  const rows = await query<KRow>('SELECT id, title, content, embedding FROM comandi.knowledge WHERE business_unit_id = $1', [businessUnitId])
  return rows
    .map((r) => ({ id: r.id, title: r.title, content: r.content, score: cosine(queryEmbedding, r.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}
