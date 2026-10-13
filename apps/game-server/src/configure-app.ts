import { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';

/** App setup shared by main.ts and e2e tests, so tests run the same transport as production. */
export function configureApp(app: INestApplication): void {
  app.useWebSocketAdapter(new WsAdapter(app));
}
