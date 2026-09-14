/* M12 regression contracts: keep the renderer/main lifecycle observable. */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');

test('M12: constructor identity is not derived from title/body/tag', () => {
  assert.match(preload, /rendererNotificationSequence/);
  assert.match(preload, /eventId: \{ value: this\._eventId/);
  assert.match(main, /duplicate suppressed id=/);
  assert.match(main, /const id = rendererId \|\| 'fallback-'/);
});

test('M12: renderer close lifecycle is forwarded and handled', () => {
  assert.match(preload, /lifecycle: \{ value: 'close'/);
  assert.match(main, /renderer Notification\.close received id=/);
  assert.match(main, /handleRendererNotificationClose/);
});

test('M12: tags are diagnostic metadata, not replacement keys', () => {
  assert.match(main, /Tags\n\/\/ are useful metadata/);
  assert.doesNotMatch(main, /dedupKey.*tag/);
});

test('M12: native notification uses GNOME default timeout and no timer close', () => {
  assert.match(main, /timeoutType: 'default'/);
  assert.match(main, /banner expires via GNOME timeout; history retained/);
  assert.doesNotMatch(main, /setTimeout\([^\n]*5000/);
});

test('M12: native lifecycle is per notification and bounded records are pruned', () => {
  assert.match(main, /native clicked id=/);
  assert.match(main, /native closed id=/);
  assert.match(main, /MAX_EVENT_RECORDS = 1000/);
  assert.match(main, /pruneNotificationEvents/);
});

test('M12: focus only clears legacy events, not shim-correlated unread events', () => {
  assert.match(main, /if \(!record\.hasRendererId && !record\.read\)/);
  assert.match(main, /Do not infer read state for shim-generated events/);
});
