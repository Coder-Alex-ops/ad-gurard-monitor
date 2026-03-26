// Vercel Serverless Function: Forecaster - Get historical data and predictions
// This runs on the server - tokens are secure here

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
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

    if (req.method === 'GET') {
      return await getHistoricalData(req, res, user);
    } else if (req.method === 'POST') {
      return await generateForecast(req, res, user);
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// GET: Fetch historical performance data
async function getHistoricalData(req, res, user) {
  const { ad_account_id, objective, days = 30 } = req.query;

  if (!ad_account_id) {
    return res.status(400).json({ error: 'ad_account_id is required' });
  }

  // Get user's Meta access token
  const { data: tokenData, error: tokenError } = await supabase
    .from('meta_tokens')
    .select('access_token, token_expires_at')
    .eq('user_id', user.id)
    .single();

  if (tokenError || !tokenData) {
    return res.status(401).json({ error: 'Meta account not connected' });
  }

  if (new Date(tokenData.token_expires_at) < new Date()) {
    return res.status(401).json({ error: 'Meta token expired' });
  }

  const accessToken = tokenData.access_token;

  // Fetch account insights with daily breakdown
  const fields = [
    'spend',
    'impressions',
    'clicks',
    'ctr',
    'cpm',
    'actions',
    'action_values',
    'cost_per_action_type',
    'purchase_roas'
  ].join(',');

  // Build date range
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(days));

  const timeRange = JSON.stringify({
    since: startDate.toISOString().split('T')[0],
    until: endDate.toISOString().split('T')[0]
  });

  let url = `https://graph.facebook.com/v21.0/act_${ad_account_id}/insights?` +
    `fields=${fields}&time_range=${encodeURIComponent(timeRange)}&time_increment=1&level=account`;

  // Filter by objective if provided
  if (objective) {
    url += `&filtering=[{"field":"objective","operator":"IN","value":["${objective}"]}]`;
  }

  url += `&access_token=${accessToken}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.error) {
    console.error('Meta API Error:', data.error);
    return res.status(400).json({ error: data.error.message });
  }

  // Process daily data
  const dailyData = (data.data || []).map(day => {
    const spend = parseFloat(day.spend || 0);
    const revenue = calculateRevenue(day.action_values);
    const results = countResults(day.actions, objective);
    
    return {
      date: day.date_start,
      spend: spend,
      impressions: parseInt(day.impressions || 0),
      clicks: parseInt(day.clicks || 0),
      ctr: parseFloat(day.ctr || 0),
      cpm: parseFloat(day.cpm || 0),
      results: results,
      revenue: revenue,
      roas: spend > 0 ? revenue / spend : 0,
      cpa: results > 0 ? spend / results : 0
    };
  });

  // Calculate aggregated stats
  const totalSpend = dailyData.reduce((sum, d) => sum + d.spend, 0);
  const totalResults = dailyData.reduce((sum, d) => sum + d.results, 0);
  const totalRevenue = dailyData.reduce((sum, d) => sum + d.revenue, 0);
  
  const avgCPA = totalResults > 0 ? totalSpend / totalResults : 0;
  const avgROAS = totalSpend > 0 ? totalRevenue / totalSpend : 0;
  const avgDailySpend = dailyData.length > 0 ? totalSpend / dailyData.length : 0;
  
  // Calculate standard deviations for confidence intervals
  const cpaValues = dailyData.filter(d => d.cpa > 0).map(d => d.cpa);
  const roasValues = dailyData.filter(d => d.roas > 0).map(d => d.roas);
  
  const cpaStdDev = calculateStdDev(cpaValues);
  const roasStdDev = calculateStdDev(roasValues);

  return res.status(200).json({
    success: true,
    data: {
      daily: dailyData,
      summary: {
        total_spend: totalSpend,
        total_results: totalResults,
        total_revenue: totalRevenue,
        avg_cpa: avgCPA,
        avg_roas: avgROAS,
        avg_daily_spend: avgDailySpend,
        cpa_std_dev: cpaStdDev,
        roas_std_dev: roasStdDev,
        days_analyzed: dailyData.length
      }
    },
    meta: {
      ad_account_id,
      objective: objective || 'all',
      date_range: {
        start: startDate.toISOString().split('T')[0],
        end: endDate.toISOString().split('T')[0]
      }
    }
  });
}

// POST: Generate forecast based on historical data
async function generateForecast(req, res, user) {
  const { ad_account_id, objective, budget, days = 30 } = req.body;

  if (!ad_account_id || !budget) {
    return res.status(400).json({ error: 'ad_account_id and budget are required' });
  }

  // First get historical data
  const historyReq = {
    query: { ad_account_id, objective, days }
  };
  
  // Get user's Meta access token
  const { data: tokenData } = await supabase
    .from('meta_tokens')
    .select('access_token')
    .eq('user_id', user.id)
    .single();

  if (!tokenData) {
    return res.status(401).json({ error: 'Meta account not connected' });
  }

  // Fetch historical data internally
  const accessToken = tokenData.access_token;
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(days));

  const fields = 'spend,actions,action_values,cost_per_action_type,purchase_roas,ctr,cpm';
  const timeRange = JSON.stringify({
    since: startDate.toISOString().split('T')[0],
    until: endDate.toISOString().split('T')[0]
  });

  const url = `https://graph.facebook.com/v21.0/act_${ad_account_id}/insights?` +
    `fields=${fields}&time_range=${encodeURIComponent(timeRange)}&time_increment=1&level=account` +
    `&access_token=${accessToken}`;

  const response = await fetch(url);
  const data = await response.json();

  if (data.error) {
    return res.status(400).json({ error: data.error.message });
  }

  // Process historical data
  const dailyData = (data.data || []).map(day => {
    const spend = parseFloat(day.spend || 0);
    const revenue = calculateRevenue(day.action_values);
    const results = countResults(day.actions, objective);
    return {
      spend,
      results,
      revenue,
      cpa: results > 0 ? spend / results : 0,
      roas: spend > 0 ? revenue / spend : 0
    };
  }).filter(d => d.spend > 0);

  if (dailyData.length < 7) {
    return res.status(400).json({ 
      error: 'Insufficient historical data. Need at least 7 days with spend.' 
    });
  }

  // Calculate statistics
  const cpaValues = dailyData.filter(d => d.cpa > 0).map(d => d.cpa);
  const roasValues = dailyData.filter(d => d.roas > 0).map(d => d.roas);

  const avgCPA = average(cpaValues);
  const avgROAS = average(roasValues);
  const cpaStdDev = calculateStdDev(cpaValues);
  const roasStdDev = calculateStdDev(roasValues);

  // Generate forecast scenarios
  const budgetNum = parseFloat(budget);
  
  const forecast = {
    budget: budgetNum,
    scenarios: {
      pessimistic: {
        cpa: avgCPA + cpaStdDev,
        roas: Math.max(0, avgROAS - roasStdDev),
        estimated_results: Math.floor(budgetNum / (avgCPA + cpaStdDev)),
        estimated_revenue: budgetNum * Math.max(0, avgROAS - roasStdDev),
        confidence: 0.85
      },
      realistic: {
        cpa: avgCPA,
        roas: avgROAS,
        estimated_results: Math.floor(budgetNum / avgCPA),
        estimated_revenue: budgetNum * avgROAS,
        confidence: 0.50
      },
      optimistic: {
        cpa: Math.max(avgCPA * 0.5, avgCPA - cpaStdDev),
        roas: avgROAS + roasStdDev,
        estimated_results: Math.floor(budgetNum / Math.max(avgCPA * 0.5, avgCPA - cpaStdDev)),
        estimated_revenue: budgetNum * (avgROAS + roasStdDev),
        confidence: 0.15
      }
    },
    historical_basis: {
      avg_cpa: avgCPA,
      avg_roas: avgROAS,
      cpa_std_dev: cpaStdDev,
      roas_std_dev: roasStdDev,
      days_analyzed: dailyData.length
    }
  };

  // Store forecast in Supabase for future reference
  await supabase.from('forecasts').upsert({
    user_id: user.id,
    ad_account_id,
    objective: objective || 'all',
    budget: budgetNum,
    forecast_data: forecast,
    created_at: new Date().toISOString()
  });

  return res.status(200).json({
    success: true,
    data: forecast,
    meta: {
      ad_account_id,
      objective: objective || 'all'
    }
  });
}

// Helper functions
function calculateRevenue(actionValues) {
  if (!actionValues || !Array.isArray(actionValues)) return 0;
  const purchaseValue = actionValues.find(av => 
    av.action_type === 'purchase' || av.action_type === 'omni_purchase'
  );
  return parseFloat(purchaseValue?.value || 0);
}

function countResults(actions, objective) {
  if (!actions || !Array.isArray(actions)) return 0;
  
  const objectiveToAction = {
    'OUTCOME_SALES': ['purchase', 'omni_purchase'],
    'OUTCOME_LEADS': ['lead', 'onsite_conversion.lead_grouped'],
    'OUTCOME_TRAFFIC': ['link_click'],
    'CONVERSIONS': ['purchase', 'lead'],
    'LEAD_GENERATION': ['lead']
  };
  
  const targetActions = objectiveToAction[objective] || ['purchase', 'lead', 'link_click'];
  
  for (const actionType of targetActions) {
    const action = actions.find(a => a.action_type === actionType);
    if (action) return parseInt(action.value || 0);
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
  const squareDiffs = arr.map(value => Math.pow(value - avg, 2));
  return Math.sqrt(average(squareDiffs));
}
