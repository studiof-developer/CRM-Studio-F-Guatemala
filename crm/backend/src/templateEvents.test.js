import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeTemplateEvent } from './templateEvents.js';

test('avisos de estado, calidad y categoría de Meta', () => {
  assert.deepEqual(describeTemplateEvent('message_template_status_update', { event: 'rejected', reason: 'INVALID_FORMAT' }), { event: 'REJECTED', detail: 'INVALID_FORMAT' });
  assert.deepEqual(describeTemplateEvent('message_template_status_update', { event: 'APPROVED', reason: 'NONE' }), { event: 'APPROVED', detail: null });
  assert.equal(describeTemplateEvent('message_template_status_update', { event: 'DISABLED', disable_info: { disable_date: '2026-10-21' } }).detail, 'deshabilitada el 2026-10-21');
  assert.deepEqual(describeTemplateEvent('message_template_quality_update', { previous_quality_score: 'GREEN', new_quality_score: 'YELLOW' }), { event: 'QUALITY_UPDATE', detail: 'GREEN → YELLOW' });
  assert.deepEqual(describeTemplateEvent('template_category_update', { previous_category: 'UTILITY', new_category: 'MARKETING' }), { event: 'CATEGORY_UPDATE', detail: 'UTILITY → MARKETING' });
  assert.equal(describeTemplateEvent('messages', {}), null);
});
