// Access control for a public deployment.
//
// Nexora's read endpoints are a dashboard: they stay open. What cannot stay open is anything that
// changes stored state or costs real compute, because on a metered host that is someone else
// spending your allowance. Those routes require a shared token.
//
// The token is compared in constant time and is never logged, echoed or returned in an error.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

const AuthSchema = z.object({
  // Absent in development: guarded routes are then open locally, which is how the Docker stack runs.
  NEXORA_API_TOKEN: z.string().trim().min(16).optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export interface AuthConfig {
  token: string | null;
  required: boolean;
}

export function loadAuthConfig(source: NodeJS.ProcessEnv = process.env): AuthConfig {
  const parsed = AuthSchema.safeParse(source);
  if (!parsed.success) {
    // Name the variable, never the value.
    throw new Error(`Invalid auth configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')} (NEXORA_API_TOKEN must be at least 16 characters)`);
  }
  const token = parsed.data.NEXORA_API_TOKEN ?? null;
  const production = parsed.data.NODE_ENV === 'production';
  if (production && !token) {
    // Failing to start is the safe outcome: the alternative is a public model-rollback endpoint.
    throw new Error('NEXORA_API_TOKEN is required when NODE_ENV=production: guarded routes would otherwise be open to anyone');
  }
  return { token, required: production };
}

function matches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak the length.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Reads the token from either header, so a browser fetch and a curl both work.
function presentedToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  const direct = request.headers['x-nexora-token'];
  if (typeof direct === 'string' && direct.length > 0) return direct.trim();
  return null;
}

export class AuthGuard {
  constructor(private readonly config: AuthConfig) {}

  get enabled(): boolean {
    return this.config.token !== null;
  }

  // True when the caller presented the token. Use this where a route is open but a privileged
  // caller gets more (a larger simulation, say), rather than open or closed outright.
  authenticated(request: FastifyRequest): boolean {
    if (!this.config.token) return true; // development: nothing is guarded locally
    const presented = presentedToken(request);
    return presented !== null && matches(presented, this.config.token);
  }

  // Attach to a route with `preHandler: guard.require`.
  readonly require = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!this.config.token) return; // development: the Docker stack is not exposed
    const presented = presentedToken(request);
    if (presented && matches(presented, this.config.token)) return;
    request.log.warn({ route: request.url, method: request.method }, 'Rejected an unauthenticated request to a guarded route');
    await reply.status(401).send({
      error: 'Unauthorized',
      message: 'This endpoint changes stored state or runs heavy computation. Send the deployment token as `Authorization: Bearer <token>`.',
    });
  };
}

// Reported by /health so a deployment can be checked without revealing anything.
export function authStatus(guard: AuthGuard): { guardedRoutesProtected: boolean } {
  return { guardedRoutesProtected: guard.enabled };
}

export function registerAuth(app: FastifyInstance, guard: AuthGuard): void {
  app.decorate('auth', guard);
}

declare module 'fastify' {
  interface FastifyInstance {
    auth: AuthGuard;
  }
}
