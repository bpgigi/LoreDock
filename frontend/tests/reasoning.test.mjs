import assert from 'node:assert/strict'
import { test } from 'node:test'
import { availableReasoningEfforts, reasoningRequest, selectedReasoning, withReasoning } from '../src/reasoning.ts'

test('legacy preferences keep the service default and omit extra request parameters', () => {
  const setting = selectedReasoning({ providerId: 'p', model: 'gpt-6.1-sol' }, 'p', 'gpt-6.1-sol')
  assert.equal(setting, 'default')
  assert.deepEqual(reasoningRequest(setting), {})
  assert.deepEqual(reasoningRequest('xhigh'), { reasoning_effort: 'xhigh' })
})

test('model and provider switches remember separate settings without changing other preferences', () => {
  let preference = withReasoning({ providerId: 'p1', model: 'custom', futureField: 'preserved' }, 'p1', 'gpt-6.1-sol', 'xhigh')
  preference = withReasoning(preference, 'p1', 'custom', 'low')
  preference = withReasoning(preference, 'p2', 'gpt-6.1-sol', 'high')
  assert.equal(selectedReasoning(preference, 'p1', 'gpt-6.1-sol'), 'xhigh')
  assert.equal(selectedReasoning(preference, 'p1', 'custom'), 'low')
  assert.equal(selectedReasoning(preference, 'p2', 'gpt-6.1-sol'), 'high')
  assert.equal(selectedReasoning(preference, 'p2', 'custom'), 'default')
  assert.equal(preference.futureField, 'preserved')
  const restored = JSON.parse(JSON.stringify(preference))
  assert.equal(selectedReasoning(restored, 'p1', 'gpt-6.1-sol'), 'xhigh')
})

test('reset removes only the current selection, and provider/model delimiters cannot collide', () => {
  let preference = withReasoning(undefined, 'p:model', 'custom', 'high')
  preference = withReasoning(preference, 'p', 'model:custom', 'medium')
  preference = withReasoning(preference, 'p:model', 'custom', 'default')
  assert.equal(selectedReasoning(preference, 'p:model', 'custom'), 'default')
  assert.equal(selectedReasoning(preference, 'p', 'model:custom'), 'medium')
})

test('confirmed legacy model limits prevent reusing an unsupported extremely high choice', () => {
  for (const model of ['gpt-5', 'gpt-5-2025-08-07']) {
    assert.deepEqual(availableReasoningEfforts(model), ['low', 'medium', 'high'])
    assert.equal(selectedReasoning(withReasoning(undefined, 'p', model, 'xhigh'), 'p', model), 'default')
  }
  assert.deepEqual(availableReasoningEfforts('gpt-6.1-sol'), ['low', 'medium', 'high', 'xhigh'])
  // Custom aliases remain configurable; no invented brand/model substitution.
  assert.equal(withReasoning(undefined, 'p', 'my-custom-model', 'high').model, 'my-custom-model')
})
