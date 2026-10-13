import type { LoginResponse } from '@crash/contracts';
import {
  Body,
  Controller,
  HttpCode,
  Post,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';

import { requestLogOf } from '../logging/request-log.middleware';
import { AuthService, isValidUsername } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: { username?: unknown } | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const username = body?.username;
    if (!isValidUsername(username)) {
      throw new UnprocessableEntityException({ errors: { username: 'invalid' } });
    }

    const user = await this.auth.login(username);
    requestLogOf(res)?.set({ userId: user.id });
    return { token: user.token, username: user.username, balance: user.balance };
  }
}
