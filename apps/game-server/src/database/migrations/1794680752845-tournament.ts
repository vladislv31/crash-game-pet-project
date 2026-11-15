import { MigrationInterface, QueryRunner } from "typeorm";

export class Tournament1794680752845 implements MigrationInterface {
    name = 'Tournament1794680752845'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`INSERT INTO "typeorm_metadata"("database", "schema", "table", "type", "name", "value") VALUES ($1, $2, $3, $4, $5, $6)`, ["crash","public","tournaments","GENERATED_COLUMN","active","ended_at IS NULL"]);
        await queryRunner.query(`CREATE TABLE "tournaments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "started_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "ended_at" TIMESTAMP WITH TIME ZONE, "active" boolean GENERATED ALWAYS AS (ended_at IS NULL) STORED NOT NULL, CONSTRAINT "PK_6d5d129da7a80cf99e8ad4833a9" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "ux_tournaments_active" ON "tournaments" ("active") WHERE "active"`);
        await queryRunner.query(`CREATE TABLE "tournament_entries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "tournament_id" uuid NOT NULL, "bet_id" uuid NOT NULL, "user_id" uuid NOT NULL, "points" integer NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_tournament_entries_bet" UNIQUE ("bet_id"), CONSTRAINT "PK_6787159985071e204cbc079bbd8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_tournament_entries_tournament_user" ON "tournament_entries" ("tournament_id", "user_id") `);
        await queryRunner.query(`ALTER TABLE "tournament_entries" ADD CONSTRAINT "FK_1e80943043013463f8872d41553" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tournament_entries" ADD CONSTRAINT "FK_47113f4bed327a0e7f94cf6a1c9" FOREIGN KEY ("bet_id") REFERENCES "bets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "tournament_entries" ADD CONSTRAINT "FK_fbe191d639b7f1a0cb672f377b5" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "tournament_entries" DROP CONSTRAINT "FK_fbe191d639b7f1a0cb672f377b5"`);
        await queryRunner.query(`ALTER TABLE "tournament_entries" DROP CONSTRAINT "FK_47113f4bed327a0e7f94cf6a1c9"`);
        await queryRunner.query(`ALTER TABLE "tournament_entries" DROP CONSTRAINT "FK_1e80943043013463f8872d41553"`);
        await queryRunner.query(`DROP INDEX "public"."ix_tournament_entries_tournament_user"`);
        await queryRunner.query(`DROP TABLE "tournament_entries"`);
        await queryRunner.query(`DROP INDEX "public"."ux_tournaments_active"`);
        await queryRunner.query(`DROP TABLE "tournaments"`);
        await queryRunner.query(`DELETE FROM "typeorm_metadata" WHERE "type" = $1 AND "name" = $2 AND "database" = $3 AND "schema" = $4 AND "table" = $5`, ["GENERATED_COLUMN","active","crash","public","tournaments"]);
    }

}
