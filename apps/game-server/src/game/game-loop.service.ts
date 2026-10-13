import { randomUUID } from 'node:crypto';

import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { generateCrashPoint } from './crash-point';
import { GameLoop } from './game-loop';

@Injectable()
export class GameLoopService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('GameLoop');
  private readonly loop = new GameLoop({
    generateCrashPoint,
    nextRoundId: randomUUID,
    onEvent: event => this.logger.log(event),
  });

  onApplicationBootstrap(): void {
    this.loop.start();
  }

  onApplicationShutdown(): void {
    this.loop.stop();
  }
}
