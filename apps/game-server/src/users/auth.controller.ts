import type { LoginResponse } from '@crash/contracts';
import { Body, Controller, HttpCode, Post, UnprocessableEntityException } from '@nestjs/common';

import { AuthService, isValidUsername } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() body: { username?: unknown } | undefined): Promise<LoginResponse> {
    const username = body?.username;
    if (!isValidUsername(username)) {
      throw new UnprocessableEntityException({ errors: { username: 'invalid' } });
    }

    return this.auth.login(username);
  }
}
