import { Global, Module } from '@nestjs/common';
import { AUTH_SUPPORT_PROVIDERS } from './global-providers.js';

/**
 * Makes the authentication and rate-limit services available to every module, including the infrastructure modules that are not
 * part of the HTTP pipeline (the Socket.IO handshake uses `Authenticator`; the chat gateway will use `RateLimiter`). The global
 * guards themselves are registered in `AppModule` (`GLOBAL_PROVIDERS`). One instance of each: the rate-limit counters, in
 * particular, are shared by HTTP and Socket.IO.
 */
@Global()
@Module({
  providers: AUTH_SUPPORT_PROVIDERS,
  exports: AUTH_SUPPORT_PROVIDERS.map((provider) =>
    'provide' in provider ? provider.provide : provider,
  ),
})
export class AuthCoreModule {}
