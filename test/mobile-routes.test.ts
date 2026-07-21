import assert from 'node:assert/strict'
import test from 'node:test'
import { buildApp } from '../src/app.js'

test('mobile status is public and versioned', async () => {
  const app = await buildApp()
  const response = await app.inject({ method: 'GET', url: '/v1/mobile/status' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { success: true, service: 'mobile-api', version: 'v1' })
  await app.close()
})
