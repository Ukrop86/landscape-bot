CREATE TABLE "day_drafts" (
	"foreman_tg_id" bigint PRIMARY KEY NOT NULL,
	"date" text DEFAULT '' NOT NULL,
	"step" text DEFAULT '' NOT NULL,
	"car_id" text DEFAULT '' NOT NULL,
	"employee_ids" text DEFAULT '[]' NOT NULL,
	"object_names" text DEFAULT '' NOT NULL,
	"trip_started_at" timestamp,
	"payload" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
