export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { google } from 'googleapis';

export async function GET() {
  try {
    const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    const sheetId = process.env.GOOGLE_SHEET_ID;

    if (!email || !key || !sheetId) {
      return NextResponse.json({
        error: true,
        message: `Missing environment variables. Email: ${!!email}, Key: ${!!key}, SheetId: ${!!sheetId}`
      });
    }

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: email,
        private_key: key,
      },
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Form Responses 1!A:Z',
    });

    const rows = response.data.values;

    if (!rows || rows.length <= 1) {
      return NextResponse.json({ leads: [], source: 'google-sheets-empty' });
    }

    const headers = rows[0];
    const leads = rows.slice(1).map((row, index) => {
      const lead: Record<string, string> = {};
      headers.forEach((header: string, i: number) => {
        lead[header] = row[i] || '';
      });
      lead['id'] = `lead-${index + 1}`;
      return lead;
    });

    return NextResponse.json({ leads, source: 'google-sheets' });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({
      error: true,
      message,
      source: 'error'
    });
  }
}
