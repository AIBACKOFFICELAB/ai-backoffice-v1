# Supabase Database Foundation - AI BackOffice

## Leads Table Schema

The pilot uses a single `leads` table to persist incoming job inquiries and status updates.

### Table: `public.leads`

Columns:
- `id` text PRIMARY KEY
- `date` timestamp with time zone NOT NULL
- `customer_name` text NOT NULL
- `phone` text NOT NULL
- `email` text
- `service_address` text NOT NULL
- `property_type` text NOT NULL
- `service_type` text NOT NULL
- `emergency` text NOT NULL
- `urgency` text NOT NULL
- `job_description` text NOT NULL
- `photos_uploaded` text NOT NULL
- `preferred_appointment_time` text
- `customer_role` text NOT NULL
- `lead_source` text NOT NULL
- `customer_notes` text
- `status` text NOT NULL
- `estimate_amount` numeric NOT NULL DEFAULT 0
- `follow_up_date` text
- `review_request_status` text NOT NULL
- `internal_notes` text
- `source` text
- `created_at` timestamp with time zone NOT NULL DEFAULT now()
- `updated_at` timestamp with time zone NOT NULL DEFAULT now()
- `sms_sent_at` timestamp with time zone

### Indexes
- `idx_leads_status` on `status`
- `idx_leads_follow_up_date` on `follow_up_date`
- `idx_leads_created_at` on `created_at`

## TypeScript Model

The TypeScript lead model now includes optional fields for persistence:
- `source`
- `createdAt`
- `updatedAt`
- `smsSentAt`

New types:
- `LeadInsert` for create payloads
- `LeadUpdate` for partial updates

## Repository Layer

The new repository supports:
- `getLeads()` - loads from Supabase first, then Google Sheets fallback
- `getLeadById(id)` - loads from Supabase first, then fallback
- `createLead(lead)` - inserts a lead into Supabase
- `updateLead(id, update)` - updates a lead in Supabase
- `deleteLead(id)` - deletes a lead from Supabase

## API Routes

### `app/api/leads/index.ts`
- `GET /api/leads` - list leads
- `POST /api/leads` - create a lead

### `app/api/leads/[id]/route.ts`
- `GET /api/leads/{id}` - fetch single lead
- `PUT /api/leads/{id}` - update single lead
- `DELETE /api/leads/{id}` - delete single lead

All routes are protected by Supabase auth via `lib/api-auth.ts`.

## Required Environment Variables

Add these to `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here

GOOGLE_SERVICE_ACCOUNT_EMAIL=your-service-account@project.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour private key here\n-----END PRIVATE KEY-----\n"
GOOGLE_SHEET_ID=your-google-sheet-id
```

## Notes

- Google Sheets integration is preserved as a temporary fallback while Supabase persistence is added.
- No multi-tenant or advanced analytics logic was added.
- The system is intended for a single pilot customer.
