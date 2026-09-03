CREATE TABLE "accounting_exports" (
	"key" text PRIMARY KEY NOT NULL,
	"date" text DEFAULT '' NOT NULL,
	"foreman_tg_id" bigint,
	"rows_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
