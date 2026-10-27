import { test } from 'node:test'
import assert from 'node:assert/strict'
import OpenAI, { toFile } from 'openai'
import { IMAGE_MODEL, imageRequestOptions } from '../src/config/image-model.js'

test('generation serializes the supported image model and preserves the PNG response contract', async () => {
  let body: any
  const client = new OpenAI({ apiKey: 'test-only', maxRetries: 0, fetch: async (_url, init) => {
    body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ data: [{ b64_json: 'cG5n' }] }), { headers: { 'content-type': 'application/json' } })
  } })
  const result = await client.images.generate({ ...imageRequestOptions, prompt: 'Agua' })
  assert.equal(body.model, 'gpt-image-2.5-sunburst')
  assert.equal(body.model, IMAGE_MODEL)
  assert.equal(body.output_format, 'png')
  assert.equal(body.n, 1)
  assert.equal(result.data?.[0]?.b64_json, 'cG5n')
})

test('editing sends the original image and omits the retired fidelity parameter', async () => {
  let body: FormData | undefined
  const client = new OpenAI({ apiKey: 'test-only', maxRetries: 0, fetch: async (_url, init) => {
    body = init?.body as FormData
    return new Response(JSON.stringify({ data: [{ b64_json: 'cG5n' }] }), { headers: { 'content-type': 'application/json' } })
  } })
  const result = await client.images.edit({ ...imageRequestOptions, prompt: 'Mejorar iluminación', image: await toFile(Buffer.from('original'), 'product.png', { type: 'image/png' }) })
  assert.equal(body?.get('model'), IMAGE_MODEL)
  assert.equal(body?.get('output_format'), 'png')
  assert.equal(body?.has('input_fidelity'), false)
  assert.equal(await (body?.get('image') as File).text(), 'original')
  assert.equal(result.data?.[0]?.b64_json, 'cG5n')
})
