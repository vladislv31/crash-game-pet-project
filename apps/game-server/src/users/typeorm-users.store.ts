import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { LedgerEntryEntity } from '../betting/ledger-entry.entity';
import { fromNumeric } from '../database/postgres';
import { User } from './user';
import { UserEntity } from './user.entity';
import { UsersStore } from './users.store';

@Injectable()
export class TypeOrmUsersStore implements UsersStore {
  constructor(private readonly dataSource: DataSource) {}

  findOrCreate(username: string, initialBalance: string, token: string): Promise<User> {
    return this.dataSource.transaction(async manager => {
      // ON CONFLICT keeps concurrent first logins of the same username from failing.
      const inserted = await manager.query<{ id: string }[]>(
        `INSERT INTO users (username, token, balance) VALUES ($1, $2, $3)
         ON CONFLICT ON CONSTRAINT uq_users_username DO NOTHING
         RETURNING id`,
        [username, token, initialBalance],
      );

      const [created] = inserted;
      if (created) {
        await manager.insert(LedgerEntryEntity, {
          userId: created.id,
          betId: null,
          type: 'INITIAL',
          amount: initialBalance,
        });
      }

      return toUser(await manager.findOneByOrFail(UserEntity, { username }));
    });
  }

  async findByToken(token: string): Promise<User | null> {
    const user = await this.dataSource.getRepository(UserEntity).findOneBy({ token });

    return user ? toUser(user) : null;
  }
}

function toUser(entity: UserEntity): User {
  return {
    id: entity.id,
    username: entity.username,
    token: entity.token,
    balance: fromNumeric(entity.balance),
  };
}
