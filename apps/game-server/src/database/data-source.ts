import { DataSource } from 'typeorm';

import { databaseOptions } from './database-options';

// Entry point for the TypeORM CLI (migration:generate, migration:run).
export default new DataSource(databaseOptions());
