CREATE TABLE "trip_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"foreman_tg_id" bigint NOT NULL,
	"created_by_tg_id" bigint NOT NULL,
	"created_by_name" text DEFAULT '' NOT NULL,
	"assigned_by_admin" boolean DEFAULT false NOT NULL,
	"car_id" text DEFAULT '' NOT NULL,
	"employee_ids" text DEFAULT '[]' NOT NULL,
	"objects" text DEFAULT '[]' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'АКТИВНИЙ' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "trip_plans_foreman_idx" ON "trip_plans" USING btree ("foreman_tg_id");--> statement-breakpoint
CREATE INDEX "trip_plans_status_idx" ON "trip_plans" USING btree ("status");