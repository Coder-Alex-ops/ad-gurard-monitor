// Vercel Serverless Function: Combined Meta API Handler
// Full campaign data with spend metrics

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://jprnvftdfnhsfeuoxkkh.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { action, account_id, user_id } = req.query;

  try {
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }

    const { data: connection, error: connError } = await supabase
      .from('meta_connections')
      .select('access_token, token_expires_at')
      .eq('user_id', user_id)
      .single();
    
    if (connError || !connection) {
      return res.status(401).json({ error: 'Meta not connected' });
    }

    if (connection.token_expires_at && new Date(connection.token_expires_at) < new Date()) {
      return res.status(401).json({ error: 'Meta token expired' });
    }

    const accessToken = connection.access_token;

    switch (action) {
      case 'accounts':
        return await handleAccounts(req, res, accessToken);
      case 'campaigns':
        return await handleCampaigns(req, res, accessToken, account_id);
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

async function handleCampaigns(req, res, accessToken, accountId) {
  if (!accountId) return res.status(400).json({ error: 'account_id required' });

  const cleanId = accountId.replace('act_', '');
  const fields = 'id,name,status,objective,daily_budget,lifetime_budget,budget_remaining,effective_status,created_time';
  const url = `https://graph.facebook.com/v21.0/act_${cleanId}/campaigns?fields=${fields}&limit=200&access_token=${accessToken}`;
  
  const response = await fetch(url);
  const data = await response.json();

  if (data.error) return res.status(400).json({ error: data.error.message });

  const campaigns = await Promise.all(
    (data.data || []).map(async (campaign) => {
      let todaySpend = 0, monthSpend = 0, yesterdaySpend = 0, last7dSpend = 0;
      let impressions = 0, clicks = 0, ctr = 0, reach = 0;

      try {
        const [todayRes, monthRes, yesterdayRes, last7dRes] = await Promise.all([
          fetch(`https://graph.facebook.com/v21.0/${campaign.id}/insights?fields=spend,impressions,clicks,ctr,reach&date_preset=today&access_token=${accessToken}`),
          fetch(`https://graph.facebook.com/v21.0/${campaign.id}/insights?fields=spend&date_preset=this_month&access_token=${accessToken}`),
          fetch(`https://graph.facebook.com/v21.0/${campaign.id}/insights?fields=spend&date_preset=yesterday&access_token=${accessToken}`),
          fetch(`https://graph.facebook.com/v21.0/${campaign.id}/insights?fields=spend&date_preset=last_7d&access_token=${accessToken}`)
        ]);

        const [todayData, monthData, yesterdayData, last7dData] = await Promise.all([
          todayRes.json(), monthRes.json(), yesterdayRes.json(), last7dRes.json()
        ]);

        if (todayData.data?.[0]) {
          todaySpend = parseFloat(todayData.data[0].spend || 0);
          impressions = parseInt(todayData.data[0].impressions || 0);
          clicks = parseInt(todayData.data[0].clicks || 0);
          ctr = parseFloat(todayData.data[0].ctr || 0);
          reach = parseInt(todayData.data[0].reach || 0);
        }
        if (monthData.data?.[0]) monthSpend = parseFloat(monthData.data[0].spend || 0);
        if (yesterdayData.data?.[0]) yesterdaySpend = parseFloat(yesterdayData.data[0].spend || 0);
        if (last7dData.data?.[0]) last7dSpend = parseFloat(last7dData.data[0].spend || 0);
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
        spend_today: todaySpend,
        spend_yesterday: yesterdaySpend,
        spend_this_month: monthSpend,
        spend_last_7d: last7dSpend,
        impressions_today: impressions,
        clicks_today: clicks,
        ctr_today: ctr,
        reach_today: reach,
        pacing_percent: pacing,
        pacing_status: pacingStatus
      };
    })
  );

  campaigns.sort((a, b) => {
    if (a.status === 'ACTIVE' && b.status !== 'ACTIVE') return -1;
    if (a.status !== 'ACTIVE' && b.status === 'ACTIVE') return 1;
    return b.spend_today - a.spend_today;
  });

  return res.status(200).json({ 
    success: true, 
    campaigns,
    summary: {
      total: campaigns.length,
      active: campaigns.filter(c => c.status === 'ACTIVE').length,
      paused: campaigns.filter(c => c.status === 'PAUSED').length,
      total_spend_today: campaigns.reduce((sum, c) => sum + c.spend_today, 0),
      total_spend_month: campaigns.reduce((sum, c) => sum + c.spend_this_month, 0)
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
