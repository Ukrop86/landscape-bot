CREATE TABLE "ui_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"ts" timestamp NOT NULL,
	"tg_id" bigint NOT NULL,
	"pib" text DEFAULT '' NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"screen" text DEFAULT '' NOT NULL,
	"step" text DEFAULT '' NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"detail" text,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ui_actions_ts_idx" ON "ui_actions" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "ui_actions_tg_idx" ON "ui_actions" USING btree ("tg_id");