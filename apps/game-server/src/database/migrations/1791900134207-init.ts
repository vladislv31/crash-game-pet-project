import { MigrationInterface, QueryRunner } from "typeorm";

export class Init1791900134207 implements MigrationInterface {
    name = 'Init1791900134207'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "username" character varying(20) NOT NULL, "token" character(64) NOT NULL, "balance" numeric(40,18) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "uq_users_token" UNIQUE ("token"), CONSTRAINT "uq_users_username" UNIQUE ("username"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "bets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "round_id" uuid NOT NULL, "user_id" uuid NOT NULL, "username" character varying(20) NOT NULL, "amount" numeric(40,18) NOT NULL, "auto_cashout" integer, "status" character varying(16) NOT NULL, "cashout_multiplier" integer, "payout" numeric(40,18), "idempotency_key" character varying(64) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "settled_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "uq_bets_user_idempotency" UNIQUE ("user_id", "idempotency_key"), CONSTRAINT "uq_bets_user_round" UNIQUE ("user_id", "round_id"), CONSTRAINT "PK_7ca91a6a39623bd5c21722bcedd" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_bets_round_status" ON "bets" ("round_id", "status") `);
        await queryRunner.query(`CREATE TABLE "ledger_entries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "bet_id" uuid, "type" character varying(16) NOT NULL, "amount" numeric(40,18) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_6efcb84411d3f08b08450ae75d5" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "ix_ledger_entries_user" ON "ledger_entries" ("user_id") `);
        await queryRunner.query(`CREATE TABLE "rounds" ("id" uuid NOT NULL, "crash_point" integer NOT NULL, "betting_ends_at" TIMESTAMP WITH TIME ZONE NOT NULL, "started_at" TIMESTAMP WITH TIME ZONE, "crashed_at" TIMESTAMP WITH TIME ZONE, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_9d254884a20817016e2f877c7e7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "bets" ADD CONSTRAINT "FK_8e3c745e288eea6d3c9475550e2" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "ledger_entries" ADD CONSTRAINT "FK_8417854ce8bdd0d651c35e1c7ce" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "ledger_entries" DROP CONSTRAINT "FK_8417854ce8bdd0d651c35e1c7ce"`);
        await queryRunner.query(`ALTER TABLE "bets" DROP CONSTRAINT "FK_8e3c745e288eea6d3c9475550e2"`);
        await queryRunner.query(`DROP TABLE "rounds"`);
        await queryRunner.query(`DROP INDEX "public"."ix_ledger_entries_user"`);
        await queryRunner.query(`DROP TABLE "ledger_entries"`);
        await queryRunner.query(`DROP INDEX "public"."ix_bets_round_status"`);
        await queryRunner.query(`DROP TABLE "bets"`);
        await queryRunner.query(`DROP TABLE "users"`);
    }

}
