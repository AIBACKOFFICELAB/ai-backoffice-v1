# Sprint 1 Task 1: Authentication Setup Guide

This document explains how to set up Supabase authentication for the AI BackOffice.

## Overview

The authentication system uses Supabase Auth to protect dashboard and lead management pages. Unauthenticated users are redirected to the login page.

## Files Created/Modified

### New Files
- `lib/supabase.ts` - Supabase client setup (browser and server)
- `lib/auth.ts` - Server-side auth utilities
- `lib/api-auth.ts` - API route auth checks
- `middleware.ts` - Route protection middleware
- `app/auth/login/page.tsx` - Login page
- `app/auth/logout/page.tsx` - Logout page

### Modified Files
- `package.json` - Added Supabase dependencies
- `components/AppShell.tsx` - Added user display and logout button
- `app/api/leads/route.ts` - Added auth check
- `app/api/sms/emergency-alert/route.ts` - Added auth check
- `.env.example` - Added Supabase env variables

## Setup Steps

### 1. Create a Supabase Project

1. Go to [supabase.com](https://supabase.com)
2. Sign up or log in
3. Create a new project:
   - Name: `ai-backoffice-pilot`
   - Region: Choose closest to your location
   - Database password: Create a strong password
4. Wait for the project to initialize (2-3 minutes)

### 2. Get Your Credentials

1. Go to **Settings > API** in your Supabase project
2. Copy and save:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` secret → `SUPABASE_SERVICE_ROLE_KEY`

### 3. Create Environment Variables

Create a `.env.local` file in the project root:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGci...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...

# Keep your existing Google Sheets variables
GOOGLE_SERVICE_ACCOUNT_EMAIL=...
GOOGLE_PRIVATE_KEY=...
GOOGLE_SHEET_ID=...
```

**Never commit `.env.local` to version control.**

### 4. Create a Test User

1. In Supabase, go to **Authentication > Users**
2. Click **Add User**
3. Enter:
   - Email: `test@example.com`
   - Password: `TestPassword123!`
   - Auto Confirm Email: ✓ (checked)
4. Click **Create User**

### 5. Install Dependencies

```bash
npm install
```

## Protected Routes

The following routes now require authentication:
- `/dashboard`
- `/lead-inbox`
- `/leads/[id]`
- `/follow-ups`
- `/review-requests`
- `/settings`

Public routes:
- `/` (landing page)
- `/auth/login`
- `/pricing` (currently, but can be protected later)

## Testing Authentication

### Test 1: Unauthenticated Redirect
1. Open `http://localhost:3000/dashboard`
2. Expected: Redirected to `/auth/login`

### Test 2: Login Flow
1. Go to `/auth/login`
2. Enter email: `test@example.com`
3. Enter password: `TestPassword123!`
4. Click "Sign In"
5. Expected: Redirected to `/dashboard`, user email visible in header

### Test 3: API Protection
```bash
# Without auth - should return 401
curl http://localhost:3000/api/leads

# With auth - should return leads
# (Auth token automatically handled by browser/fetch with cookies)
fetch('/api/leads', { credentials: 'include' })
```

### Test 4: Logout
1. Click "Sign Out" in the header
2. Expected: Redirected to `/auth/login`

### Test 5: Direct Dashboard Access After Login
1. Log in at `/auth/login`
2. Navigate to `/dashboard`
3. Expected: Dashboard loads normally, user email visible

## Architecture

### Client-Side (`lib/supabase.ts`)
- `createClient()` - Browser-side Supabase client for auth operations
- Used in login/logout pages

### Server-Side (`lib/supabase.ts`)
- `createServerSupabaseClient()` - Server-side Supabase client
- Manages auth state via cookies
- Used in server components and API routes

### Middleware (`middleware.ts`)
- Verifies auth state on every request
- Refreshes session tokens if needed
- Redirects unauthenticated users to login
- Redirects authenticated users away from login page

### API Auth (`lib/api-auth.ts`)
- `checkAuth()` - Validates auth token in API requests
- Returns 401 if user is not authenticated
- Used in all protected API endpoints

## Security Considerations

1. **Environment Variables**: Never expose `SUPABASE_SERVICE_ROLE_KEY` in client-side code
2. **Cookie Security**: Auth tokens are stored in httpOnly cookies (set by Supabase SSR)
3. **CSRF Protection**: Next.js middleware handles CSRF tokens automatically
4. **Session Refresh**: Supabase SSR automatically refreshes expired tokens

## Multi-Tenant Note

This implementation is **single-tenant only** for the pilot. Each customer would need:
1. A separate Supabase project, OR
2. A `tenant_id` or `organization_id` column in auth metadata

We'll revisit this in a future sprint if needed.

## Troubleshooting

### "Missing Supabase environment variables"
- Ensure `.env.local` has all three Supabase variables
- Restart the dev server: `npm run dev`

### "Unauthorized" (401) on API calls
- Check that auth token is being sent
- Verify user is logged in
- Clear browser cookies and log in again

### Login page shows but won't authenticate
- Verify the test user exists in Supabase > Authentication > Users
- Check that email is not locked/inactive
- Try signing up a new user via a sign-up page (can add in future sprint)

### Middleware not redirecting
- Ensure `middleware.ts` is in project root (not in `app/` directory)
- Check Next.js version is 14.2+ (required for `@supabase/ssr`)

## Next Steps (Not in Sprint 1)

- Add sign-up page for new users
- Add password reset flow
- Add multi-tenant support if scaling beyond pilot
- Add role-based access control (RBAC)
- Add audit logging for compliance

## Questions?

Refer to:
- [Supabase Auth Docs](https://supabase.com/docs/guides/auth)
- [Supabase SSR Guide](https://supabase.com/docs/guides/auth/server-side-rendering)
- [Next.js Authentication](https://nextjs.org/docs/app/building-your-application/authentication)
