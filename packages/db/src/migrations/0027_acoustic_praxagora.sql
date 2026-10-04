CREATE TYPE "public"."COURSE_ORDER_ATTENTION_REASON" AS ENUM('DUPLICATE_PAYMENT', 'ALREADY_ENROLLED', 'AMOUNT_MISMATCH', 'ENROLLMENT_FAILED');--> statement-breakpoint
CREATE TYPE "public"."COURSE_ORDER_STATUS" AS ENUM('CREATED', 'PAID');--> statement-breakpoint
CREATE TABLE "course_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"course_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'INR' NOT NULL,
	"razorpay_order_id" varchar NOT NULL,
	"razorpay_payment_id" varchar,
	"status" "COURSE_ORDER_STATUS" DEFAULT 'CREATED' NOT NULL,
	"paid_at" timestamp with time zone,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"attention_reason" "COURSE_ORDER_ATTENTION_REASON",
	"attention_payment_ids" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "course_order_razorpay_order_id_key" UNIQUE("razorpay_order_id"),
	CONSTRAINT "course_order_amount_paise_check" CHECK ("course_order"."amount_paise" > 0),
	CONSTRAINT "course_order_currency_check" CHECK ("course_order"."currency" = 'INR')
);
--> statement-breakpoint
ALTER TABLE "course_order" ADD CONSTRAINT "course_order_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_order" ADD CONSTRAINT "course_order_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_order" ADD CONSTRAINT "course_order_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "public"."course"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_order_razorpay_payment_id_unique" ON "course_order" USING btree ("razorpay_payment_id") WHERE "course_order"."razorpay_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_course_order_user_course" ON "course_order" USING btree ("user_id","course_id");