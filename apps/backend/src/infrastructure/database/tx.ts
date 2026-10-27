import type { Prisma } from '../../generated/prisma/client.js';

/** The client passed to a function running inside `TransactionService.run`. */
export type Tx = Prisma.TransactionClient;
