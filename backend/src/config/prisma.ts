import { PrismaClient } from '@prisma/client';

// A serverless function is re-entered many times in the same process. Creating a client per
// invocation opens a new pool each time and exhausts Postgres, so the instance is cached on
// globalThis and reused. Under Docker this simply returns the same single client.
const globalForPrisma = globalThis as unknown as { nexoraPrisma?: PrismaClient };

export function createPrismaClient(): PrismaClient {
  globalForPrisma.nexoraPrisma ??= new PrismaClient();
  return globalForPrisma.nexoraPrisma;
}
