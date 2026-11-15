import type { TournamentStatusResponse } from '@crash/contracts';
import { Body, Controller, Get, Put, Res, UnprocessableEntityException } from '@nestjs/common';
import type { Response } from 'express';

import { requestLogOf } from '../logging/request-log.middleware';
import { TournamentStatus, TournamentsService } from './tournaments.service';

/** The tournament switch of the test dashboard (ADR-0009); no auth, like the rest of the pet project's controls. */
@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournaments: TournamentsService) {}

  @Get('active')
  status(): TournamentStatusResponse {
    return toResponse(this.tournaments.status());
  }

  @Put('active')
  async setActive(
    @Body() body: { active?: unknown } | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TournamentStatusResponse> {
    const active = body?.active;
    if (typeof active !== 'boolean') {
      throw new UnprocessableEntityException({ errors: { active: 'invalid' } });
    }

    const status = await this.tournaments.setActive(active);
    requestLogOf(res)?.set({ tournamentId: status.tournament?.id ?? null, active });
    return toResponse(status);
  }
}

function toResponse({ tournament, active }: TournamentStatus): TournamentStatusResponse {
  return {
    tournament: tournament && {
      id: tournament.id,
      startedAt: tournament.startedAt.getTime(),
      endedAt: tournament.endedAt?.getTime() ?? null,
    },
    active,
  };
}
