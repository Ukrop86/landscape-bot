CREATE TABLE "trip_progress" (
	"id" text PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"foreman_tg_id" bigint NOT NULL,
	"state" text NOT NULL,
	"object_name" text DEFAULT '' NOT NULL,
	"people_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
