import { Injectable } from '@nestjs/common';

/** The personal room of a user; every socket of the user joins it (docs/architecture.md section 14). */
export const userRoom = (userId: string): string => `user:${userId}`;

/**
 * Which sockets each user has right now (in memory, single instance: Decision 153). A user can be connected from several devices
 * and tabs; `wasLastSocket` of `socket.disconnected` and presence are derived from this count.
 */
@Injectable()
export class SocketRegistry {
  private readonly sockets = new Map<string, Set<string>>();

  /** Registers a socket; returns the number of sockets the user now has. */
  add(userId: string, socketId: string): number {
    const set = this.sockets.get(userId) ?? new Set<string>();
    set.add(socketId);
    this.sockets.set(userId, set);
    return set.size;
  }

  /** Removes a socket; returns how many the user has left (0 = it was the last one). */
  remove(userId: string, socketId: string): number {
    const set = this.sockets.get(userId);
    if (!set) return 0;
    set.delete(socketId);
    if (set.size === 0) this.sockets.delete(userId);
    return set.size;
  }

  count(userId: string): number {
    return this.sockets.get(userId)?.size ?? 0;
  }

  isOnline(userId: string): boolean {
    return this.count(userId) > 0;
  }

  /** Users with at least one socket. */
  onlineUsers(): number {
    return this.sockets.size;
  }
}
