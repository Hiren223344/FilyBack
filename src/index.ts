import { buildApp } from './app.js';
import { env } from './config/env.js';
import { runMigrationsUp } from './db/migrate.js';
import { runSeed } from './db/seed.js';
import { closePool } from './db/index.js';
import { closeRedis } from './db/redis.js';
import { usageAggregatorService } from './services/usage-aggregator.service.js';
import { rollupService } from './services/rollup.service.js';
import { createMockUpstreamServer } from './mock-upstream/server.js';

async function bootstrap() {
  console.log(`\n========================================================`);
  console.log(`  🌟 FilyBase Inference Gateway (Node.js ${process.version})`);
  console.log(`========================================================\n`);

  // 1. Run migrations and initial seeds if DB is reachable
  try {
    console.log('🔄 Checking database schema migrations...');
    await runMigrationsUp();
    console.log('🔄 Seeding model registry from models.yaml...');
    await runSeed();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ Database initialization warning (will retry on incoming calls): ${msg}`);
  }

  // 2. Optional: Start Mock Upstream in dev mode if enabled
  if (env.MOCK_UPSTREAM_ENABLED && env.NODE_ENV !== 'production') {
    try {
      const mockPort = env.MOCK_UPSTREAM_PORT;
      const { app: mockApp } = await createMockUpstreamServer(mockPort);
      await mockApp.listen({ port: mockPort, host: '0.0.0.0' });
      console.log(`🤖 Mock Upstream GPU Server active on port http://127.0.0.1:${mockPort}`);
    } catch {
      console.log(`ℹ️ Upstream port ${env.MOCK_UPSTREAM_PORT} is in use (connected to existing process).`);
    }
  }

  // 3. Build & Start Gateway App
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    console.log(`\n🚀 FilyBase Gateway is listening on http://${env.HOST}:${env.PORT}`);
    console.log(`   - Health Check:    http://${env.HOST}:${env.PORT}/healthz`);
    console.log(`   - Prometheus:      http://${env.HOST}:${env.PORT}/metrics`);
    console.log(`   - OpenAI Base URL: http://${env.HOST}:${env.PORT}/v1\n`);
  } catch (err) {
    console.error('❌ Failed to start server:', err);
    process.exit(1);
  }

  // Graceful Shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}, starting graceful shutdown...`);
    try {
      rollupService.stop();
      await app.close();
      console.log('✓ HTTP Server closed');

      console.log('Flushing pending usage events to Postgres...');
      await usageAggregatorService.shutdown();
      console.log('✓ Usage buffer flushed');

      await closePool();
      console.log('✓ PostgreSQL pool closed');

      await closeRedis();
      console.log('✓ Redis connection closed');

      console.log('👋 FilyBase Gateway shutdown cleanly.');
      process.exit(0);
    } catch (err) {
      console.error('Error during graceful shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled Promise Rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
    shutdown('uncaughtException').catch(() => process.exit(1));
  });
}

bootstrap().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
