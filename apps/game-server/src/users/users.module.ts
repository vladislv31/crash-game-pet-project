import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TypeOrmUsersStore } from './typeorm-users.store';
import { USERS_STORE } from './users.store';

@Module({
  controllers: [AuthController],
  providers: [AuthService, { provide: USERS_STORE, useClass: TypeOrmUsersStore }],
  exports: [AuthService],
})
export class UsersModule {}
