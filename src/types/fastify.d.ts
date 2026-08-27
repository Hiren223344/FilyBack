import { Account, ApiKey, Project, Model } from './db.types.js';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    startTime: number;
    user?: {
      accountId: string;
      email: string;
      name: string;
    };
    apiKey?: ApiKey;
    project?: Project;
    resolvedModel?: Model;
    reserveId?: string;
    estimatedCredits?: number;
    acquiredConcurrency?: boolean;
  }
}
