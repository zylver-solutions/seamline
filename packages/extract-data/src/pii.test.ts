import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyPii } from './pii.ts';

test('obvious PII column names are classified with their category', () => {
  const cases: ReadonlyArray<readonly [string, 'text' | 'timestamp' | 'numeric' | 'other', string]> = [
    ['email', 'text', 'email'],
    ['email_address', 'text', 'email'],
    ['userEmail', 'text', 'email'],
    ['phone', 'text', 'phone'],
    ['phone_number', 'text', 'phone'],
    ['ssn', 'text', 'ssn'],
    ['social_security_number', 'text', 'ssn'],
    ['date_of_birth', 'timestamp', 'dob'],
    ['dob', 'timestamp', 'dob'],
    ['street_address', 'text', 'address'],
    ['postal_code', 'text', 'address'],
    ['ip_address', 'text', 'ip_address'],
    ['client_ip', 'other', 'ip_address'],
    ['first_name', 'text', 'person_name'],
    ['password_hash', 'text', 'credential'],
    ['latitude', 'numeric', 'geo'],
  ];
  for (const [name, category, expected] of cases) {
    const v = classifyPii(name, category);
    assert.equal(v.category, expected, `${name} (${category})`);
    assert.ok(v.confidence > 0 && v.confidence < 1, `${name} confidence must be a calibrated guess`);
  }
});

test('email_verified_at is a timestamp about an address, not an address', () => {
  assert.equal(classifyPii('email_verified_at', 'timestamp').category, 'none');
  assert.equal(classifyPii('email_verified', 'boolean').category, 'none');
  assert.equal(classifyPii('emailVerifiedAt', 'timestamp').category, 'none');
  assert.equal(classifyPii('phone_confirmed_at', 'timestamp').category, 'none');
  // The same name in a type that can hold the datum still fires.
  assert.equal(classifyPii('email', 'text').category, 'email');
});

test('the declared type gates every rule', () => {
  // A count of emails is not an email.
  assert.equal(classifyPii('email_count', 'integer').category, 'none');
  // A boolean cannot hold a postal address.
  assert.equal(classifyPii('address', 'boolean').category, 'none');
  assert.equal(classifyPii('address', 'text').category, 'address');
});

test('near-miss names do not fire', () => {
  const negatives: ReadonlyArray<readonly [string, 'text' | 'integer' | 'timestamp' | 'json']> = [
    ['table_name', 'text'],
    ['file_name', 'text'],
    ['wallet_address', 'text'],
    ['mac_address', 'text'],
    ['created_at', 'timestamp'],
    ['id', 'integer'],
    ['slug', 'text'],
    ['metadata', 'json'],
    ['description', 'text'],
    ['email_template', 'text'],
  ];
  for (const [name, category] of negatives) {
    assert.equal(classifyPii(name, category).category, 'none', name);
  }
});

test('a column comment can classify a name that cannot, at lower confidence', () => {
  const fromName = classifyPii('contact', 'text');
  assert.equal(fromName.category, 'none');

  const fromComment = classifyPii('contact', 'text', 'The user email address on file');
  assert.equal(fromComment.category, 'email');
  assert.equal(fromComment.evidence, 'column-comment');
  assert.ok(fromComment.confidence < classifyPii('email', 'text').confidence);
});

test('an exact name match outranks a partial one', () => {
  const exact = classifyPii('email', 'text');
  const partial = classifyPii('user_email_backup', 'text');
  assert.equal(exact.category, 'email');
  assert.equal(partial.category, 'email');
  assert.ok(exact.confidence > partial.confidence);
});

test('a non-PII verdict carries no confidence and no evidence', () => {
  const v = classifyPii('created_at', 'timestamp');
  assert.deepEqual({ ...v }, { category: 'none', confidence: 0, evidence: '' });
});
