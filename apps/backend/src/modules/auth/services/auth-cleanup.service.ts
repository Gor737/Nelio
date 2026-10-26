import { Injectable } from '@nestjs/common';
import { EmailTokensService } from './email-tokens.service.js';
import { SessionsService } from './sessions.service.js';

/**
 * The expired-token cleanup (roadmap M11a, architecture section 17): refresh tokens that expired more than a day ago and email tokens that
 * expired or were used more than a day ago. Nothing the application still needs is removed (the newest-token cooldown and reuse detection
 * only look at recent rows). A callable method; the nightly schedule is wired in M13.
 */
@Injectable()
export class AuthCleanupService {
  constructor(
    private readonly sessions: SessionsService,
    private readonly emailTokens: EmailTokensService,
  ) {}

  async run(): Promise<{ refreshTokens: number; emailTokens: number }> {
    return {
      refreshTokens: await this.sessions.cleanupExpired(),
      emailTokens: await this.emailTokens.cleanupExpired(),
    };
  }
}
