import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authService } from '../../services/auth.service.js';
import { requireJwtAuth } from '../../middleware/jwt.middleware.js';
import { rateLimit } from '../../middleware/rate-limit.middleware.js';
import { query, withTransaction } from '../../db/index.js';
import { AUTH, BILLING, CREDITS_PER_USD } from '../../config/constants.js';

// Cap password length: Argon2 hashing cost scales with input size, so an
// unbounded field is a cheap DoS vector.
const SignupSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Invalid email address').max(254),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters long')
    .max(200, 'Password must be at most 200 characters long'),
});

const LoginSchema = z.object({
  email: z.string().email('Invalid email address').max(254),
  password: z.string().min(1, 'Password is required').max(200),
});

const signupLimiter = rateLimit({ scope: 'auth:signup', max: 5, windowMs: 60 * 60 * 1000 });
const loginLimiter = rateLimit({ scope: 'auth:login', max: 10, windowMs: 15 * 60 * 1000 });

export const dashboardAuthRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /v1/auth/signup
   */
  fastify.post('/auth/signup', { preHandler: [signupLimiter] }, async (req, reply) => {
    const parseResult = SignupSchema.safeParse(req.body);
    if (!parseResult.success) {
      reply.status(400).send({
        statusCode: 400,
        error: 'Validation Error',
        message: parseResult.error.errors[0]?.message || 'Invalid input',
      });
      return;
    }

    const { name, email, password } = parseResult.data;

    // Check if email already exists
    const existing = await query('SELECT id FROM accounts WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      reply.status(409).send({
        statusCode: 409,
        error: 'Conflict',
        message: 'An account with this email address already exists.',
      });
      return;
    }

    const passwordHash = await authService.hashPassword(password);

    const user = await withTransaction(async (client) => {
      const accRes = await client.query<{ id: string; email: string; name: string }>(
        'INSERT INTO accounts (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name',
        [name, email, passwordHash]
      );
      const acc = accRes.rows[0];
      if (!acc) throw new Error('Failed to create account');

      // Create default project
      const projRes = await client.query<{ id: string }>(
        'INSERT INTO projects (account_id, name) VALUES ($1, $2) RETURNING id',
        [acc.id, 'Default Project']
      );
      const proj = projRes.rows[0];
      if (!proj) throw new Error('Failed to create project');

      // Seed the one-time free trial balance.
      const initialCredits = BILLING.TRIAL_CREDIT_USD * CREDITS_PER_USD;
      await client.query(
        'INSERT INTO balances (account_id, credits) VALUES ($1, $2)',
        [acc.id, initialCredits]
      );

      await client.query(
        'INSERT INTO ledger (account_id, delta, reason, ref) VALUES ($1, $2, $3, $4)',
        [acc.id, initialCredits, `Free trial credit ($${BILLING.TRIAL_CREDIT_USD})`, 'SIGNUP_TRIAL']
      );

      // Create default demo API key for project
      const apiKeyData = authService.generateApiKey();
      await client.query(
        'INSERT INTO api_keys (project_id, name, key_hash, prefix, last4) VALUES ($1, $2, $3, $4, $5)',
        [proj.id, 'Default Key', apiKeyData.keyHash, apiKeyData.prefix, apiKeyData.last4]
      );

      return {
        id: acc.id,
        email: acc.email,
        name: acc.name,
        projectId: proj.id,
        defaultApiKey: apiKeyData.rawKey,
      };
    });

    const userPayload = { accountId: user.id, email: user.email, name: user.name };
    const accessToken = authService.generateAccessToken(userPayload);
    const refreshToken = authService.generateRefreshToken(userPayload);

    // Set httpOnly cookie for refresh token
    reply.setCookie(AUTH.REFRESH_COOKIE_NAME, refreshToken, {
      path: '/v1/auth',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: AUTH.REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60,
    });

    reply.status(201).send({
      token: accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        default_project_id: user.projectId,
        initial_api_key: user.defaultApiKey,
      },
    });
  });

  /**
   * POST /v1/auth/login
   */
  fastify.post('/auth/login', { preHandler: [loginLimiter] }, async (req, reply) => {
    const parseResult = LoginSchema.safeParse(req.body);
    if (!parseResult.success) {
      reply.status(400).send({
        statusCode: 400,
        error: 'Validation Error',
        message: parseResult.error.errors[0]?.message || 'Invalid input',
      });
      return;
    }

    const { email, password } = parseResult.data;

    const res = await query<{
      id: string;
      email: string;
      password_hash: string;
      name: string;
    }>('SELECT id, email, password_hash, name FROM accounts WHERE email = $1', [email]);

    if (res.rows.length === 0) {
      reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid email or password.',
      });
      return;
    }

    const account = res.rows[0];
    if (!account) {
      reply.status(401).send({ statusCode: 401, error: 'Unauthorized', message: 'Invalid credentials.' });
      return;
    }

    const isValid = await authService.verifyPassword(account.password_hash, password);
    if (!isValid) {
      reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid email or password.',
      });
      return;
    }

    const userPayload = {
      accountId: account.id,
      email: account.email,
      name: account.name,
    };
    const accessToken = authService.generateAccessToken(userPayload);
    const refreshToken = authService.generateRefreshToken(userPayload);

    reply.setCookie(AUTH.REFRESH_COOKIE_NAME, refreshToken, {
      path: '/v1/auth',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: AUTH.REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60,
    });

    reply.send({
      token: accessToken,
      user: {
        id: account.id,
        email: account.email,
        name: account.name,
      },
    });
  });

  /**
   * POST /v1/auth/refresh
   */
  fastify.post('/auth/refresh', async (req, reply) => {
    const cookieToken = req.cookies[AUTH.REFRESH_COOKIE_NAME];
    if (!cookieToken) {
      reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Refresh token cookie missing',
      });
      return;
    }

    try {
      const payload = authService.verifyRefreshToken(cookieToken);
      const newAccessToken = authService.generateAccessToken({
        accountId: payload.accountId,
        email: payload.email,
        name: payload.name,
      });
      const newRefreshToken = authService.generateRefreshToken({
        accountId: payload.accountId,
        email: payload.email,
        name: payload.name,
      });

      reply.setCookie(AUTH.REFRESH_COOKIE_NAME, newRefreshToken, {
        path: '/v1/auth',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: AUTH.REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60,
      });

      reply.send({
        token: newAccessToken,
        user: {
          id: payload.accountId,
          email: payload.email,
          name: payload.name,
        },
      });
    } catch {
      reply.status(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: 'Invalid or expired refresh token',
      });
    }
  });

  /**
   * POST /v1/auth/logout
   */
  fastify.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(AUTH.REFRESH_COOKIE_NAME, { path: '/v1/auth' });
    reply.send({ message: 'Successfully logged out' });
  });

  /**
   * GET /v1/auth/me
   */
  fastify.get('/auth/me', { preHandler: [requireJwtAuth] }, async (req, reply) => {
    const user = req.user!;
    const projects = await query<{ id: string; name: string; created_at: Date }>(
      'SELECT id, name, created_at FROM projects WHERE account_id = $1 ORDER BY created_at ASC',
      [user.accountId]
    );

    reply.send({
      user: {
        id: user.accountId,
        email: user.email,
        name: user.name,
      },
      projects: projects.rows,
    });
  });
};
