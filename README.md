# AI Backoffice v1

Next.js App Router app.

## Routes
- /
- /dashboard
- /lead-inbox
- /leads/[id]
- /follow-ups
- /review-requests
- /pricing
- /settings

## Google Sheet Lead Source Setup
1. Create `.env.local` from `.env.example`.
2. Add `GOOGLE_SHEETS_SPREADSHEET_ID` (from your sheet URL).
3. Add `GOOGLE_SHEETS_RANGE` (default: `Sheet1!A:T`).
4. Add `GOOGLE_SHEETS_API_KEY` (server-only, do not expose in frontend).
5. Ensure the Google Sheet columns match the form headers exactly.

If these variables are missing or the API call fails, the app automatically falls back to mock plumbing leads.

## Emergency SMS Owner Alerts (Phase 1)
Internal-only SMS alerts are available via a server route.

### Environment variables
Add these to `.env.local` and Vercel project settings:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `OWNER_ALERT_PHONE`

If any Twilio variable is missing, SMS sending is skipped safely and the app does not crash.

### API route
- `POST /api/sms/emergency-alert`

This route sends an owner SMS only when:
- `emergency` equals `Yes` (case-insensitive), or
- `urgency` contains `Emergency`.

Request payload example:
```json
{
  "customerName": "Jane Doe",
  "phone": "(555) 111-2222",
  "serviceType": "Burst Pipe",
  "serviceAddress": "123 Main St, Dallas, TX",
  "urgency": "Emergency - ASAP",
  "emergency": "Yes"
}
```

## API
- `GET /api/leads` returns `{ leads, source }`
  - `source: "google-sheets"` when live data works
  - `source: "mock-fallback"` when credentials are missing or request fails

## Commands
```bash
npm install
npm run lint
npm run build
```
