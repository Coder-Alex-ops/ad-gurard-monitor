// Vercel Serverless Function to trigger daily budget check
// Called by Vercel Cron at 18:00 UTC (20:00 BG time)

export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  // Verify this is a cron request from Vercel
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  
  // Allow Vercel cron (no auth) or manual trigger with secret
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';
  const isAuthorized = authHeader === `Bearer ${cronSecret}`;
  
  if (!isVercelCron && !isAuthorized) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    // Call Supabase Edge Function
    const supabaseUrl = process.env.SUPABASE_URL;
    const response = await fetch(`${supabaseUrl}/functions/v1/daily-budget-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cronSecret}`,
      },
    });

    const result = await response.json();

    return new Response(
      JSON.stringify({
        success: true,
        timestamp: new Date().toISOString(),
        result,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Cron job error:', error);
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
