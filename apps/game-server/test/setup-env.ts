// Integration tests use their own database, so they never touch dev data.
process.env.POSTGRES_DB = process.env.POSTGRES_TEST_DB ?? 'crash_test';
