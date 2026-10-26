import { Module } from '@nestjs/common';
import { MailModule } from '../../infrastructure/mail/index.js';
import { UsersModule } from '../users/index.js';
import { AuthController } from './controllers/auth.controller.js';
import { AuthCleanupService } from './services/auth-cleanup.service.js';
import { AuthService } from './services/auth.service.js';
import { EmailTokensService } from './services/email-tokens.service.js';
import {
  GoogleAuthService,
  GoogleLibraryVerifier,
  GoogleTokenVerifier,
} from './services/google-auth.service.js';
import { PasswordService } from './services/password.service.js';
import { SessionsService } from './services/sessions.service.js';
import { TokenIssuer } from './services/token-issuer.service.js';

/**
 * Auth (Layer 2): passwords, sessions, email tokens and Google sign-in. It owns `RefreshToken`, `AuthIdentity` and `EmailToken`, calls
 * Users for the account primitives, and is the only module that sends mail. `SessionsService.revokeAllSessions(tx, userId)` is its
 * public API for Admin's suspension transaction.
 */
@Module({
  imports: [UsersModule, MailModule],
  controllers: [AuthController],
  providers: [
    PasswordService,
    TokenIssuer,
    SessionsService,
    EmailTokensService,
    AuthService,
    GoogleAuthService,
    AuthCleanupService,
    { provide: GoogleTokenVerifier, useClass: GoogleLibraryVerifier },
  ],
  exports: [SessionsService, AuthCleanupService],
})
export class AuthModule {}
