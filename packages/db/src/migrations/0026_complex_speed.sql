CREATE TYPE "public"."CONTENT_REPORT_REASON" AS ENUM('spam', 'harassment', 'hate_speech', 'sexual_content', 'violence', 'misinformation', 'privacy', 'other');--> statement-breakpoint
CREATE TYPE "public"."CONTENT_REPORT_RESOLUTION_CODE" AS ENUM('removed', 'warned', 'restricted', 'no_action', 'duplicate');--> statement-breakpoint
CREATE TYPE "public"."CONTENT_REPORT_STATUS" AS ENUM('open', 'in_review', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."CONTENT_REPORT_TARGET_TYPE" AS ENUM('course_newsfeed_post', 'course_newsfeed_comment', 'cohort_newsfeed_post', 'cohort_newsfeed_comment', 'community_question', 'community_answer', 'lesson_comment', 'profile');--> statement-breakpoint
CREATE TYPE "public"."ORGANIZATION_MEMBER_EVENT_TYPE" AS ENUM('DEACTIVATED', 'REACTIVATED', 'ARCHIVED', 'UNARCHIVED', 'REMOVED');--> statement-breakpoint
CREATE TYPE "public"."ORGANIZATION_MEMBER_STATUS" AS ENUM('ACTIVE', 'DEACTIVATED', 'ARCHIVED');--> statement-breakpoint
ALTER TYPE "public"."LOCALE" ADD VALUE 'tr';--> statement-breakpoint
CREATE TABLE "content_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"reporter_id" uuid,
	"target_type" "CONTENT_REPORT_TARGET_TYPE" NOT NULL,
	"target_id" text NOT NULL,
	"target_author_id" uuid,
	"reason" "CONTENT_REPORT_REASON" NOT NULL,
	"details" text,
	"status" "CONTENT_REPORT_STATUS" DEFAULT 'open' NOT NULL,
	"priority" integer DEFAULT 2 NOT NULL,
	"content_snapshot" jsonb NOT NULL,
	"assigned_to" uuid,
	"resolution_code" "CONTENT_REPORT_RESOLUTION_CODE",
	"resolution_note" text,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "course_template_setting_sync" (
	"course_id" uuid NOT NULL,
	"setting_key" varchar NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "course_template_setting_sync_course_id_setting_key_pk" PRIMARY KEY("course_id","setting_key")
);
--> statement-breakpoint
CREATE TABLE "organization_member_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" bigint,
	"profile_id" uuid,
	"target_email" varchar,
	"event_type" "ORGANIZATION_MEMBER_EVENT_TYPE" NOT NULL,
	"actor_profile_id" uuid,
	"reason" text,
	"filter_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_highlight" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" varchar(80) NOT NULL,
	"description" varchar(200)
);
--> statement-breakpoint
ALTER TABLE "course" ALTER COLUMN "is_template" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "course" ALTER COLUMN "is_template" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "course_section" ALTER COLUMN "order" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "course_section" ALTER COLUMN "order" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "exercise" ALTER COLUMN "order" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "lesson" ALTER COLUMN "order" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "course" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "course" ADD COLUMN "public_for_all" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "course" ADD COLUMN "seed_key" varchar;--> statement-breakpoint
ALTER TABLE "course_section" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "course_section" ADD COLUMN "source_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "exercise" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "exercise" ADD COLUMN "source_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lesson" ADD COLUMN "slides" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "lesson" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "lesson" ADD COLUMN "source_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lesson_language" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "organizationmember" ADD COLUMN "status" "ORGANIZATION_MEMBER_STATUS" DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizationmember" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizationmember" ADD COLUMN "status_changed_by" uuid;--> statement-breakpoint
ALTER TABLE "organizationmember" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_report" ADD CONSTRAINT "content_report_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_report" ADD CONSTRAINT "content_report_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_report" ADD CONSTRAINT "content_report_target_author_id_fkey" FOREIGN KEY ("target_author_id") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_report" ADD CONSTRAINT "content_report_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_report" ADD CONSTRAINT "content_report_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_template_setting_sync" ADD CONSTRAINT "course_template_setting_sync_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member_audit" ADD CONSTRAINT "organization_member_audit_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member_audit" ADD CONSTRAINT "organization_member_audit_actor_profile_id_fkey" FOREIGN KEY ("actor_profile_id") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_highlight" ADD CONSTRAINT "template_highlight_course_id_course_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_content_report_status_priority_created" ON "content_report" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE INDEX "idx_content_report_org_created" ON "content_report" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_content_report_target" ON "content_report" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_report_reporter_target_open_unique" ON "content_report" USING btree ("organization_id","reporter_id","target_type","target_id") WHERE "content_report"."reporter_id" IS NOT NULL AND "content_report"."status" IN ('open', 'in_review');--> statement-breakpoint
CREATE INDEX "idx_organization_member_audit_org_id" ON "organization_member_audit" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idx_organization_member_audit_member_id" ON "organization_member_audit" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "idx_organization_member_audit_profile_id" ON "organization_member_audit" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "idx_organization_member_audit_event_type" ON "organization_member_audit" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_organization_member_audit_created_at" ON "organization_member_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "template_highlight_course_id_idx" ON "template_highlight" USING btree ("course_id");--> statement-breakpoint
ALTER TABLE "course" ADD CONSTRAINT "course_template_id_course_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."course"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_section" ADD CONSTRAINT "course_section_source_id_course_section_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."course_section"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise" ADD CONSTRAINT "exercise_source_id_exercise_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."exercise"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lesson" ADD CONSTRAINT "lesson_source_id_lesson_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."lesson"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizationmember" ADD CONSTRAINT "organizationmember_status_changed_by_fkey" FOREIGN KEY ("status_changed_by") REFERENCES "public"."profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_template_id_idx" ON "course" USING btree ("template_id") WHERE "course"."template_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "course_seed_key_unique" ON "course" USING btree ("seed_key") WHERE "course"."seed_key" is not null;--> statement-breakpoint
CREATE INDEX "course_section_source_id_idx" ON "course_section" USING btree ("source_id") WHERE "course_section"."source_id" is not null;--> statement-breakpoint
CREATE INDEX "exercise_source_id_idx" ON "exercise" USING btree ("source_id") WHERE "exercise"."source_id" is not null;--> statement-breakpoint
CREATE INDEX "lesson_source_id_idx" ON "lesson" USING btree ("source_id") WHERE "lesson"."source_id" is not null;--> statement-breakpoint
CREATE INDEX "idx_orgmember_org_role_status" ON "organizationmember" USING btree ("organization_id","role_id","status");--> statement-breakpoint
CREATE INDEX "idx_orgmember_org_last_active" ON "organizationmember" USING btree ("organization_id","last_active_at");