// Vercel Serverless Function: Meta API with date filtering
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jprnvftdfnhsfeuoxkkh.supabase.co';

const supabaseAdmin = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const supabaseAuth = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || ''
);

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigins = [
    'https://adguardian.tech',
    'http://localhost:3000'
  ];
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Authenticate via Supabase JWT
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Authorization header required' });
  }

  const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const user_id = user.id;
  const { action, account_id, date_preset, date_from, date_to } = req.query;

  try {
    const { data: connection, error: connError } = await supabaseAdmin
      .from('meta_connections')
      .select('access_token, token_expires_at')
      .eq('user_id', user_id)
      .single();
    
    if (connError || !connection) return res.status(401).json({ error: 'Meta not connected' });
    if (connection.token_expires_at && new Date(connection.token_expires_at) < new Date()) {
      return res.status(401).json({ error: 'Meta token expired' });
    }

    const accessToken = connection.access_token;

    switch (action) {
      case 'accounts':
        return await handleAccounts(req, res, accessToken);
      case 'campaigns':
        return await handleCampaigns(req, res, accessToken, account_id, date_preset, date_from, date_to);
      case 'account-insights':
        return await handleAccountInsights(req, res, accessToken, account_id);
      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (error) {
    console.error('Meta API error:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function handleAccounts(req, res, accessToken) {
  const fields = 'id,name,account_id,account_status,currency,timezone_name,spend_cap,amount_spent';
  const url = `https://graph.facebook.com/v21.0/me/adaccounts?fields=${fields}&access_token=${accessToken}`;
  
  const response = await fetch(url);
  const data = await response.json();
  if (data.error) return res.status(400).json({ error: data.error.message });

  const accounts = (data.data || []).map(a => ({
    id: a.account_id,
    account_id: a.account_id,
    name: a.name,
    account_status: a.account_status,
    currency: a.currency,
    timezone: a.timezone_name,
    spend_cap: a.spend_cap ? parseFloat(a.spend_cap) / 100 : null,
    amount_spent: a.amount_spent ? parseFloat(a.amount_spent) / 100 : 0
  }));

  return res.status(200).json({ success: true, accounts });
}

function getDateRange(preset, dateFrom, dateTo) {
  const today = new Date();
  let since, until;
  
  switch (preset) {
    case 'today':
      since = until = formatDate(today);
      break;
    case 'yesterday':
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      since = until = formatDate(yesterday);
      break;
    case 'last_3d':
      const threeDaysAgo = new Date(today);
      threeDaysAgo.setDate(threeDaysAgo.getDate() - 2);
      since = formatDate(threeDaysAgo);
      until = formatDate(today);
      break;
    case 'last_7d':
      const sevenDaysAgo = new Date(today);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      since = formatDate(sevenDaysAgo);
      until = formatDate(today);
      break;
    case 'last_14d':
      const fourteenDaysAgo = new Date(today);
      fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 13);
      since = formatDate(fourteenDaysAgo);
      until = formatDate(today);
      break;
    case 'last_30d':
      const thirtyDaysAgo = new Date(today);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
      since = formatDate(thirtyDaysAgo);
      until = formatDate(today);
      break;
    case 'this_month':
      since = formatDate(new Date(today.getFullYear(), today.getMonth(), 1));
      until = formatDate(today);
      break;
    case 'last_month':
      const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
      since = formatDate(lastMonthStart);
      until = formatDate(lastMonthEnd);
      break;
    case 'custom':
      since = dateFrom || formatDate(today);
      until = dateTo || formatDate(today);
      break;
    default:
      since = until = formatDate(today);
  }
  
  return { since, until };
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

async function handleCampaigns(req, res, accessToken, accountId, datePreset, dateFrom, dateTo) {
  if (!accountId) return res.status(400).json({ error: 'account_id required' });

  const cleanId = accountId.replace('act_', '');
  const fields = 'id,name,status,objective,daily_budget,lifetime_budget,budget_remaining,effective_status,created_time';
  const url = `https://graph.facebook.com/v21.0/act_${cleanId}/campaigns?fields=${fields}&limit=200&access_token=${accessToken}`;
  
  const response = await fetch(url);
  const data = await response.json();
  if (data.error) return res.status(400).json({ error: data.error.message });

  const { since, until } = getDateRange(datePreset || 'today', dateFrom, dateTo);
  const timeRange = JSON.stringify({ since, until });

  const campaigns = await Promise.all(
    (data.data || []).map(async (campaign) => {
      let periodSpend = 0, todaySpend = 0;
      let impressions = 0, clicks = 0, ctr = 0, reach = 0, conversions = 0, cpc = 0, cpm = 0;

      try {
        // Get spend for selected period
        const periodUrl = `https://graph.facebook.com/v21.0/${campaign.id}/insights?fields=spend,impressions,clicks,ctr,reach,actions,cpc,cpm&time_range=${encodeURIComponent(timeRange)}&access_token=${accessToken}`;
        const periodRes = await fetch(periodUrl);
        const periodData = await periodRes.json();
        
        if (periodData.data?.[0]) {
          const d = periodData.data[0];
          periodSpend = parseFloat(d.spend || 0);
          impressions = parseInt(d.impressions || 0);
          clicks = parseInt(d.clicks || 0);
          ctr = parseFloat(d.ctr || 0);
          reach = parseInt(d.reach || 0);
          cpc = parseFloat(d.cpc || 0);
          cpm = parseFloat(d.cpm || 0);
          
          // Count conversions from actions
          if (d.actions) {
            const convActions = ['purchase', 'lead', 'complete_registration', 'add_to_cart'];
            d.actions.forEach(function(a) {
              if (convActions.indexOf(a.action_type) !== -1) {
                conversions += parseInt(a.value || 0);
              }
            });
          }
        }

        // Always get today's spend for pacing calculation
        const todayUrl = `https://graph.facebook.com/v21.0/${campaign.id}/insights?fields=spend&date_preset=today&access_token=${accessToken}`;
        const todayRes = await fetch(todayUrl);
        const todayData = await todayRes.json();
        if (todayData.data?.[0]) {
          todaySpend = parseFloat(todayData.data[0].spend || 0);
        }
      } catch (e) {}

      const dailyBudget = campaign.daily_budget ? parseFloat(campaign.daily_budget) / 100 : null;
      let pacing = null, pacingStatus = 'unknown';
      
      if (dailyBudget && dailyBudget > 0) {
        const now = new Date();
        const hoursElapsed = now.getUTCHours() + (now.getUTCMinutes() / 60);
        const expectedSpend = dailyBudget * (hoursElapsed / 24);
        if (expectedSpend > 0) {
          pacing = Math.round((todaySpend / expectedSpend) * 100);
          if (pacing > 120) pacingStatus = 'overspending';
          else if (pacing < 50) pacingStatus = 'underspending';
          else pacingStatus = 'on_track';
        }
      }

      return {
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        effective_status: campaign.effective_status,
        objective: campaign.objective,
        daily_budget: dailyBudget,
        lifetime_budget: campaign.lifetime_budget ? parseFloat(campaign.lifetime_budget) / 100 : null,
        budget_remaining: campaign.budget_remaining ? parseFloat(campaign.budget_remaining) / 100 : null,
        created_time: campaign.created_time,
        // Period metrics (based on selected date range)
        spend: periodSpend,
        impressions: impressions,
        clicks: clicks,
        ctr: ctr,
        reach: reach,
        conversions: conversions,
        cpc: cpc,
        cpm: cpm,
        // Today's pacing
        spend_today: todaySpend,
        pacing_percent: pacing,
        pacing_status: pacingStatus
      };
    })
  );

  campaigns.sort((a, b) => {
    if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1;
    if (a.status !== 'ACTIVE' && b.status === 'ACTIVE') return 1;
    return b.spend - a.spend;
  });

  const totalSpend = campaigns.reduce((sum, c) => sum + c.spend, 0);
  const totalImpressions = campaigns.reduce((sum, c) => sum + c.impressions, 0);
  const totalClicks = campaigns.reduce((sum, c) => sum + c.clicks, 0);
  const totalConversions = campaigns.reduce((sum, c) => sum + c.conversions, 0);

  return res.status(200).json({ 
    success: true, 
    campaigns,
    date_range: { since, until, preset: datePreset || 'today' },
    summary: {
      total: campaigns.length,
      active: campaigns.filter(c => c.status === 'ACTIVE').length,
      paused: campaigns.filter(c => c.status === 'PAUSED').length,
      total_spend: totalSpend,
      total_impressions: totalImpressions,
      total_clicks: totalClicks,
      total_conversions: totalConversions,
      avg_ctr: totalImpressions > 0 ? (totalClicks / totalImpressions * 100).toFixed(2) : 0,
      avg_cpc: totalClicks > 0 ? (totalSpend / totalClicks).toFixed(2) : 0
    }
  });
}

async function handleAccountInsights(req, res, accessToken, accountId) {
  if (!accountId) return res.status(400).json({ error: 'account_id required' });

  const cleanId = accountId.replace('act_', '');
  const presets = ['today', 'yesterday', 'this_month', 'last_7d', 'last_30d'];
  const insights = {};

  await Promise.all(presets.map(async (preset) => {
    try {
      const url = `https://graph.facebook.com/v21.0/act_${cleanId}/insights?fields=spend,impressions,clicks,reach,ctr&date_preset=${preset}&access_token=${accessToken}`;
      const response = await fetch(url);
      const data = await response.json();
      
      if (data.data?.[0]) {
        insights[preset] = {
          spend: parseFloat(data.data[0].spend || 0),
          impressions: parseInt(data.data[0].impressions || 0),
          clicks: parseInt(data.data[0].clicks || 0),
          reach: parseInt(data.data[0].reach || 0),
          ctr: parseFloat(data.data[0].ctr || 0)
        };
      } else {
        insights[preset] = { spend: 0, impressions: 0, clicks: 0, reach: 0, ctr: 0 };
      }
    } catch (e) {
      insights[preset] = { spend: 0, impressions: 0, clicks: 0, reach: 0, ctr: 0 };
    }
  }));

  return res.status(200).json({ success: true, insights });
}
