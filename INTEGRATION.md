# FilyBase — Frontend ⇄ Backend Integration

This repo now contains two connected services:

| Service | Path | Stack | Port |
|---|---|---|---|
| Backend (inference gateway) | `Filybase-back/` | Fastify + PostgreSQL + Redis | `8080` |
| Frontend (dashboard + landing) | `Kiln serverless inference landing/` | Next.js 14 (App Router) | `3000` |

## How they connect (BFF proxy)

The browser **never** talks to the gateway directly and **never** holds a JWT.

```
browser ──same-origin──▶ Next /api/v1/*  ──Bearer JWT──▶ Fastify gateway /v1/*
             (httpOnly cookies)        (server-to-server)
```

* `lib/api.js` calls `/v1/...`; `next.config.js` rewrites that to `/api/v1/...`.
* `app/api/v1/[...path]/route.js` is a catch-all proxy. It reads the access
  token from the httpOnly `fb_access` cookie, adds `Authorization: Bearer …`,
  and forwards to `BACKEND_ORIGIN`. On `401` it transparently refreshes using
  the `fb_refresh` cookie and retries once.
* `app/api/v1/auth/{login,signup,logout,refresh,me}/route.js` handle the auth
  handshake: they call the gateway, then move the returned access token and the
  gateway's `fb_refresh_token` into httpOnly, `SameSite=Lax` cookies. Tokens are
  never returned in a response body to the browser.

## Run locally

```bash
# 1. Backend — needs Postgres + Redis (docker compose up -d postgres redis)
cd Filybase-back
cp .env.example .env
npm install
npm run dev            # migrates + seeds, listens on :8080

# 2. Frontend
cd "../Kiln serverless inference landing"
cp .env.example .env.local     # BACKEND_ORIGIN=http://localhost:8080
npm install
npm run dev            # http://localhost:3000
```

Sign up at `/signup` → you land on `/dashboard` with real data from the gateway.
Manage keys at `/api-keys`.

## Security hardening applied

**Frontend**
- JWTs held only in `httpOnly` cookies (was `localStorage` → XSS-exfiltratable).
- Removed the in-memory mock API + mock auth entirely.
- `middleware.js`: security headers on every response + cookie gate on
  `/dashboard`, `/endpoints`, `/billing`, `/api-keys`, `/playground`.
- `next.config.js`: CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, `poweredByHeader: false`.
- Proxy strips client-supplied `Authorization`/`Cookie` before calling the gateway.
- Open-redirect guard on the post-login `redirect_url`.

**Backend**
- Refuses to boot in `production` with sample secrets, `JWT_SECRET == JWT_REFRESH_SECRET`, or `CORS_ORIGINS=*`.
- JWT verification pinned to `HS256` (algorithm-confusion defense).
- Baseline security headers on every gateway response (`onSend` hook).
- In-memory fixed-window rate limits on `/v1/auth/login` (10 / 15 min / IP) and
  `/v1/auth/signup` (5 / h / IP).
- Password fields capped at 200 chars (Argon2 DoS guard); email capped at 254.
- `DELETE /v1/keys/:id`: id format validated, ownership re-checked in the
  `UPDATE`, idempotent on already-revoked keys.
