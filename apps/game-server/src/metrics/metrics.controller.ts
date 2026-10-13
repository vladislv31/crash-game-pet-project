import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

import { Metrics } from './metrics';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: Metrics) {}

  @Get('metrics')
  scrape(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}
