// Vercel Serverless Function: Get Ad Accounts from Meta API
// This runs on the server - tokens are secure here

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Get user from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }

    const token = authHeader.split(' ')[1];
    
    // Verify user with Supabase
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get user's Meta access token from Supabase
    const { data: tokenData, error: tokenError } = await supabase
      .from('meta_tokens')
      .select('access_token, token_expires_at')
      .eq('user_id', user.id)
      .single();

    if (tokenError || !tokenData) {
      return res.status(401).json({ error: 'Meta account not connected', code: 'META_NOT_CONNECTED' });
    }

    // Check if token is expired
    if (new Date(tokenData.token_expires_at) < new Date()) {
      return res.status(401).json({ error: 'Meta token expired, please reconnect', code: 'TOKEN_EXPIRED' });
    }

    const accessToken = tokenData.access_token;

    // Fetch ad accounts from Meta API
    const fields = [
      'id',
      'name',
      'account_id',
      'account_status',
      'currency',
      'timezone_name',
      'spend_cap',
      'amount_spent',
      'balance',
      'business{name}'
    ].join(',');

    const url = `https://graph.facebook.com/v21.0/me/adaccounts?fields=${fields}&access_token=${accessToken}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      console.error('Meta API Error:', data.error);
      return res.status(400).json({ error: data.error.message });
    }

    // Process and format accounts
    const accounts = (data.data || []).map(account => ({
      id: account.account_id,
      account_id: account.account_id,
      name: account.name,
      status: getAccountStatus(account.account_status),
      currency: account.currency,
      timezone: account.timezone_name,
      spend_cap: account.spend_cap ? parseFloat(account.spend_cap) / 100 : null,
      amount_spent: account.amount_spent ? parseFloat(account.amount_spent) / 100 : 0,
      balance: account.balance ? parseFloat(account.balance) / 100 : 0,
      business_name: account.business?.name || null
    }));

    // Also fetch today's spend for each account
    const accountsWithSpend = await Promise.all(
      accounts.map(async (account) => {
        try {
          const insightsUrl = `https://graph.facebook.com/v21.0/act_${account.account_id}/insights?` +
            `fields=spend,impressions,clicks,actions&date_preset=today&access_token=${accessToken}`;
          
          const insightsResponse = await fetch(insightsUrl);
          const insightsData = await insightsResponse.json();
          
          const todayData = insightsData.data?.[0] || {};
          
          return {
            ...account,
            today_spend: parseFloat(todayData.spend || 0),
            today_impressions: parseInt(todayData.impressions || 0),
            today_clicks: parseInt(todayData.clicks || 0)
          };
        } catch (err) {
          return {
            ...account,
            today_spend: 0,
            today_impressions: 0,
            today_clicks: 0
          };
        }
      })
    );

    return res.status(200).json({
      success: true,
      data: accountsWithSpend,
      meta: {
        total_accounts: accountsWithSpend.length
      }
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Helper: Convert account status code to readable string
function getAccountStatus(statusCode) {
  const statuses = {
    1: 'ACTIVE',
    2: 'DISABLED',
    3: 'UNSETTLED',
    7: 'PENDING_RISK_REVIEW',
    8: 'PENDING_SETTLEMENT',
    9: 'IN_GRACE_PERIOD',
    100: 'PENDING_CLOSURE',
    101: 'CLOSED',
    201: 'ANY_ACTIVE',
    202: 'ANY_CLOSED'
  };
  return statuses[statusCode] || 'UNKNOWN';
}
