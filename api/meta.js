// Vercel Serverless Function: Combined Meta API Handler
// Uses Supabase for auth and meta_connections (NO Redis)

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

  const { action, account_id } = req.query;

  try {
    // Get user from Authorization header (Bearer token from Supabase)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    
    const token = authHeader.replace('Bearer ', '');
    
    // Verify the JWT and get user
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get Meta access token from meta_connections
    const { data: connection, error: connError } = await supabase
      .from('meta_connections')
      .select('access_token, token_expires_at')
      .eq('user_id', user.id)
      .single();
    
    if (connError || !connection) {
      return res.status(401).json({ error: 'Meta not connected. Please connect your Meta account.' });
    }

    // Check if token expired
    if (connection.token_expires_at && new Date(connection.token_expires_at) < new Date()) {
      return res.status(401).json({ error: 'Meta token expired. Please reconnect.' });
    }

    const accessToken = connection.access_token;

    // Route to handler
    switch (action) {
      case 'accounts':
        return await handleAccounts(req, res, accessToken);
      case 'campaigns':
        return await handleCampaigns(req, res, accessToken, account_id);
      case 'top-ads':
        return await handleTopAds(req, res, accessToken);
      case 'forecaster':
        return await handleForecaster(req, res, accessToken);
      default:
        return res.status(400).json({ 
          error: 'Invalid action', 
          valid_actions: ['accounts', 'campaigns', 'top-ads', 'forecaster'] 
        });
    }

  } catch (error) {
    console.error('Meta API error:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
}

// ============================================
// ACCOUNTS - Get ad accounts from Meta
// ============================================
async function handleAccounts(req, res, accessToken) {
  const fields = 'id,name,account_id,account_status,currency,timezone_name,spend_cap,amount_spent,balance';
  const url = `https://graph.facebook.com/v21.0/me/adaccounts?fields=${fields}&access_token=${accessToken}`;
  
  const response = await fetch(url);
  const data = await response.json();

  if (data.error) {
    return res.status(400).json({ error: data.error.message });
  }

  const accounts = (data.data || []).map(account => ({
    id: account.account_id,
    account_id: account.account_id,
    name: account.name,
    account_status: account.account_status,
    status: getAccountStatus(account.account_status),
    currency: account.currency,
    timezone: account.timezone_name,
    spend_cap: account.spend_cap ? parseFloat(account.spend_cap) / 100 : null,
    amount_spent: account.amount_spent ? parseFloat(account.amount_spent) / 100 : 0
  }));

  return res.status(200).json({ success: true, accounts });
}

// ============================================
// CAMPAIGNS - Get campaigns for an account
// ============================================
async function handleCampaigns(req, res, accessToken, accountId) {
  if (!accountId) {
    return res.status(400).json({ error: 'account_id is required' });
  }

  // Remove 'act_' prefix if present
  const cleanId = accountId.replace('act_', '');
  
  const fields = 'id,name,status,objective,daily_budget,lifetime_budget,budget_remaining,effective_status';
  const url = `https://graph.facebook.com/v21.0/act_${cleanId}/campaigns?fields=${fields}&limit=100&access_token=${accessToken}`;
  
  const response = await fetch(url);
  const data = await response.json();

  if (data.error) {
    return res.status(400).json({ error: data.error.message });
  }

  const campaigns = (data.data || []).map(campaign => ({
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    effective_status: campaign.effective_status,
    objective: campaign.objective,
    daily_budget: campaign.daily_budget ? parseFloat(campaign.daily_budget) / 100 : null,
    lifetime_budget: campaign.lifetime_budget ? parseFloat(campaign.lifetime_budget) / 100 : null,
    budget_remaining: campaign.budget_remaining ? parseFloat(campaign.budget_remaining) / 100 : null
  }));

  return res.status(200).json({ success: true, campaigns });
}

// ============================================
// TOP ADS - Get top performing ads
// ============================================
async function handleTopAds(req, res, accessToken) {
  const { ad_account_id, date_preset = 'last_7d', limit = 10, sort_by = 'roas' } = req.query;
  
  if (!ad_account_id) {
    return res.status(400).json({ error: 'ad_account_id is required' });
  }

  const cleanId = ad_account_id.replace('act_', '');
  const adsUrl = `https://graph.facebook.com/v21.0/act_${cleanId}/ads?fields=id,name,status,campaign{name,objective}&limit=50&effective_status=['ACTIVE']&access_token=${accessToken}`;
  const adsResponse = await fetch(adsUrl);
  const adsData = await adsResponse.json();

  if (adsData.error) {
    return res.status(400).json({ error: adsData.error.message });
  }

  const insightsFields = 'spend,impressions,clicks,ctr,actions,action_values,cost_per_action_type,quality_ranking,engagement_rate_ranking,conversion_rate_ranking';
  
  const adsWithInsights = await Promise.all(
    (adsData.data || []).slice(0, 30).map(async (ad) => {
      try {
        const insightsUrl = `https://graph.facebook.com/v21.0/${ad.id}/insights?fields=${insightsFields}&date_preset=${date_preset}&access_token=${accessToken}`;
        const insightsRes = await fetch(insightsUrl);
        const insightsData = await insightsRes.json();
        const insights = insightsData.data?.[0] || {};

        const spend = parseFloat(insights.spend || 0);
        const revenue = calculateRevenue(insights.action_values);
        const roas = spend > 0 ? revenue / spend : 0;
        const results = countResults(insights.actions, ad.campaign?.objective);
        const cpa = results > 0 ? spend / results : 0;

        return {
          ad_id: ad.id,
          ad_name: ad.name,
          campaign_name: ad.campaign?.name,
          objective: ad.campaign?.objective,
          spend,
          impressions: parseInt(insights.impressions || 0),
          clicks: parseInt(insights.clicks || 0),
          results,
          revenue,
          roas,
          cpa,
          ctr: parseFloat(insights.ctr || 0),
          quality_ranking: insights.quality_ranking || 'UNKNOWN',
          engagement_rate_ranking: insights.engagement_rate_ranking || 'UNKNOWN',
          conversion_rate_ranking: insights.conversion_rate_ranking || 'UNKNOWN'
        };
      } catch (e) {
        return null;
      }
    })
  );

  let validAds = adsWithInsights.filter(ad => ad !== null && ad.spend > 0);

  validAds.sort((a, b) => {
    switch (sort_by) {
      case 'roas': return b.roas - a.roas;
      case 'cpa': return a.cpa - b.cpa;
      case 'spend': return b.spend - a.spend;
      case 'ctr': return b.ctr - a.ctr;
      case 'results': return b.results - a.results;
      default: return b.roas - a.roas;
    }
  });

  return res.status(200).json({
    success: true,
    data: validAds.slice(0, parseInt(limit)),
    meta: { ad_account_id, date_preset, sort_by, total_count: validAds.length }
  });
}

// ============================================
// FORECASTER - Historical data and predictions
// ============================================
async function handleForecaster(req, res, accessToken) {
  if (req.method === 'POST') {
    const { ad_account_id, objective, budget, days = 30 } = req.body;

    if (!ad_account_id || !budget) {
      return res.status(400).json({ error: 'ad_account_id and budget are required' });
    }

    const cleanId = ad_account_id.replace('act_', '');
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const timeRange = JSON.stringify({
      since: startDate.toISOString().split('T')[0],
      until: endDate.toISOString().split('T')[0]
    });

    const url = `https://graph.facebook.com/v21.0/act_${cleanId}/insights?fields=spend,actions,action_values&time_range=${encodeURIComponent(timeRange)}&time_increment=1&access_token=${accessToken}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    const dailyData = (data.data || []).map(day => {
      const spend = parseFloat(day.spend || 0);
      const revenue = calculateRevenue(day.action_values);
      const results = countResults(day.actions, objective);
      return { spend, results, revenue, cpa: results > 0 ? spend / results : 0, roas: spend > 0 ? revenue / spend : 0 };
    }).filter(d => d.spend > 0);

    if (dailyData.length < 7) {
      return res.status(400).json({ error: 'Insufficient data. Need at least 7 days with spend.' });
    }

    const cpaValues = dailyData.filter(d => d.cpa > 0).map(d => d.cpa);
    const roasValues = dailyData.filter(d => d.roas > 0).map(d => d.roas);
    const avgCPA = average(cpaValues);
    const avgROAS = average(roasValues);
    const cpaStdDev = calculateStdDev(cpaValues);
    const roasStdDev = calculateStdDev(roasValues);
    const budgetNum = parseFloat(budget);

    return res.status(200).json({
      success: true,
      data: {
        budget: budgetNum,
        scenarios: {
          pessimistic: { cpa: avgCPA + cpaStdDev, roas: Math.max(0, avgROAS - roasStdDev), estimated_results: Math.floor(budgetNum / (avgCPA + cpaStdDev)), estimated_revenue: budgetNum * Math.max(0, avgROAS - roasStdDev) },
          realistic: { cpa: avgCPA, roas: avgROAS, estimated_results: Math.floor(budgetNum / avgCPA), estimated_revenue: budgetNum * avgROAS },
          optimistic: { cpa: Math.max(avgCPA * 0.5, avgCPA - cpaStdDev), roas: avgROAS + roasStdDev, estimated_results: Math.floor(budgetNum / Math.max(avgCPA * 0.5, avgCPA - cpaStdDev)), estimated_revenue: budgetNum * (avgROAS + roasStdDev) }
        },
        historical_basis: { avg_cpa: avgCPA, avg_roas: avgROAS, cpa_std_dev: cpaStdDev, roas_std_dev: roasStdDev, days_analyzed: dailyData.length }
      }
    });
  }

  // GET - return historical data
  const { ad_account_id, days = 30 } = req.query;
  
  if (!ad_account_id) {
    return res.status(400).json({ error: 'ad_account_id is required' });
  }

  const cleanId = ad_account_id.replace('act_', '');
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(days));

  const timeRange = JSON.stringify({
    since: startDate.toISOString().split('T')[0],
    until: endDate.toISOString().split('T')[0]
  });

  const fields = 'spend,impressions,clicks,ctr,actions,action_values';
  const url = `https://graph.facebook.com/v21.0/act_${cleanId}/insights?fields=${fields}&time_range=${encodeURIComponent(timeRange)}&time_increment=1&access_token=${accessToken}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.error) {
    return res.status(400).json({ error: data.error.message });
  }

  const dailyData = (data.data || []).map(day => {
    const spend = parseFloat(day.spend || 0);
    const revenue = calculateRevenue(day.action_values);
    const results = countResults(day.actions);
    return {
      date: day.date_start,
      spend,
      impressions: parseInt(day.impressions || 0),
      clicks: parseInt(day.clicks || 0),
      results,
      revenue,
      roas: spend > 0 ? revenue / spend : 0,
      cpa: results > 0 ? spend / results : 0
    };
  });

  const totalSpend = dailyData.reduce((sum, d) => sum + d.spend, 0);
  const totalResults = dailyData.reduce((sum, d) => sum + d.results, 0);
  const totalRevenue = dailyData.reduce((sum, d) => sum + d.revenue, 0);

  return res.status(200).json({
    success: true,
    data: {
      daily: dailyData,
      summary: {
        total_spend: totalSpend,
        total_results: totalResults,
        total_revenue: totalRevenue,
        avg_cpa: totalResults > 0 ? totalSpend / totalResults : 0,
        avg_roas: totalSpend > 0 ? totalRevenue / totalSpend : 0,
        days_analyzed: dailyData.length
      }
    }
  });
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function getAccountStatus(statusCode) {
  const statuses = { 1: 'ACTIVE', 2: 'DISABLED', 3: 'UNSETTLED', 7: 'PENDING_RISK_REVIEW', 101: 'CLOSED' };
  return statuses[statusCode] || 'UNKNOWN';
}

function calculateRevenue(actionValues) {
  if (!actionValues || !Array.isArray(actionValues)) return 0;
  const purchase = actionValues.find(av => av.action_type === 'purchase' || av.action_type === 'omni_purchase');
  return parseFloat(purchase?.value || 0);
}

function countResults(actions, objective) {
  if (!actions || !Array.isArray(actions)) return 0;
  const map = {
    'OUTCOME_SALES': ['purchase', 'omni_purchase'],
    'OUTCOME_LEADS': ['lead', 'onsite_conversion.lead_grouped'],
    'OUTCOME_TRAFFIC': ['link_click'],
    'CONVERSIONS': ['purchase', 'lead'],
    'LEAD_GENERATION': ['lead']
  };
  const targets = map[objective] || ['purchase', 'lead', 'link_click'];
  for (const t of targets) {
    const a = actions.find(x => x.action_type === t);
    if (a) return parseInt(a.value || 0);
  }
  return 0;
}

function average(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function calculateStdDev(arr) {
  if (arr.length < 2) return 0;
  const avg = average(arr);
  const squareDiffs = arr.map(v => Math.pow(v - avg, 2));
  return Math.sqrt(average(squareDiffs));
}
