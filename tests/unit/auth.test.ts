import '../setup.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AuthService } from '../../src/services/auth.service.js';
import { AUTH } from '../../src/config/constants.js';

describe('AuthService', () => {
  const authService = new AuthService();

  it('hashes passwords with Argon2id parameters (timeCost=2, memoryCost=65536, parallelism=2)', async () => {
    const password = 'SuperSecretSecurePassword!123';
    const hash = await authService.hashPassword(password);

    assert.ok(hash.startsWith('$argon2id$'), 'Must use Argon2id variant');
    assert.ok(hash.includes('m=65536,t=2,p=2'), 'Must enforce memoryCost=65536, timeCost=2, parallelism=2');

    const isValid = await authService.verifyPassword(hash, password);
    assert.equal(isValid, true, 'Valid password must verify');

    const isInvalid = await authService.verifyPassword(hash, 'WrongPassword');
    assert.equal(isInvalid, false, 'Invalid password must fail verification');
  });

  it('generates compliant API keys with sk-fb- prefix and SHA-256 hash', () => {
    const { rawKey, keyHash, prefix, last4 } = authService.generateApiKey();

    assert.ok(rawKey.startsWith(AUTH.KEY_PREFIX), `Key must start with ${AUTH.KEY_PREFIX}`);
    assert.equal(rawKey.length > 30, true, 'Key must have sufficient entropy');
    assert.equal(prefix, rawKey.slice(0, 10));
    assert.equal(last4, rawKey.slice(-4));

    // Verify SHA-256 digest
    const expectedHash = crypto.createHash('sha256').update(rawKey).digest();
    assert.deepEqual(keyHash, expectedHash);
  });

  it('generates and verifies JWT dashboard access tokens', () => {
    const payload = {
      accountId: '00000000-0000-0000-0000-000000000001',
      email: 'user@example.com',
      name: 'Test User',
    };

    const token = authService.generateAccessToken(payload);
    assert.ok(typeof token === 'string' && token.split('.').length === 3);

    const verified = authService.verifyAccessToken(token);
    assert.equal(verified.accountId, payload.accountId);
    assert.equal(verified.email, payload.email);
  });
});
