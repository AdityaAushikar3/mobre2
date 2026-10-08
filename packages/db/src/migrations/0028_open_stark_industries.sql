CREATE TYPE "public"."RAZORPAY_WEBHOOK_EVENT_STATUS" AS ENUM('PROCESSING', 'PROCESSED', 'IGNORED', 'FAILED');--> statement-breakpoint
CREATE TABLE "razorpay_webhook_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" "RAZORPAY_WEBHOOK_EVENT_STATUS" NOT NULL,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "razorpay_webhook_event_provider_event_id_unique" UNIQUE("provider_event_id")
);
