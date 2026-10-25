import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';

/**
 * Largest packet the server accepts, in bytes. A message is at most 2000 characters (about 8 KB in UTF-8 at worst), so 64 KB is
 * ample and an oversized packet closes the connection instead of being buffered. A proposed default (docs/proposed-defaults.md).
 */
export const MAX_SOCKET_PAYLOAD_BYTES = 64 * 1024;

/**
 * Socket.IO server options that depend on configuration: CORS for the browser handshake (only the frontend origin, with
 * credentials) and the packet size cap. The Origin of the WebSocket upgrade itself is checked by the handshake middleware.
 */
export class RealtimeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly frontendOrigin: string,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions) {
    const merged = {
      ...options,
      cors: { origin: this.frontendOrigin, credentials: true },
      maxHttpBufferSize: MAX_SOCKET_PAYLOAD_BYTES,
      serveClient: false,
    } as ServerOptions;
    return super.createIOServer(port, merged);
  }
}
