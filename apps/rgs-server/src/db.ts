import { PrismaClient } from './generated/prisma/index.js';

// Single process-wide client. Prisma handles pooling internally.
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
});

export type Prisma = typeof prisma;
