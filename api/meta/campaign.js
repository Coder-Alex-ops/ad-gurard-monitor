// Vercel Serverless Function: Get Campaigns and Budget data from Meta API
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

    // Get query params
    const { ad_account_id } = req.query;

    if (!ad_account_id) {
      return res.status(400).json({ error: 'ad_account_id is required' });
    }

    // Get user's Meta access token from Supabase
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

    // Fetch campaigns with budget info
    const campaignFields = [
      'id',
      'name',
      'status',
      'objective',
      'daily_budget',
      'lifetime_budget',
      'budget_remaining',
      'start_time',
      'stop_time',
      'created_time'
    ].join(',');

    const campaignsUrl = `https://graph.facebook.com/v21.0/act_${ad_account_id}/campaigns?` +
      `fields=${campaignFields}&limit=100&access_token=${accessToken}`;

    const campaignsResponse = await fetch(campaignsUrl);
    const campaignsData = await campaignsResponse.json();

    if (campaignsData.error) {
      console.error('Meta API Error:', campaignsData.error);
      return res.status(400).json({ error: campaignsData.error.message });
    }

    // Get today's spend for each campaign
    const campaignsWithSpend = await Promise.all(
      (campaignsData.data || []).map(async (campaign) => {
        try {
          // Get insights for this month
          const insightsUrl = `https://graph.facebook.com/v21.0/${campaign.id}/insights?` +
            `fields=spend,impressions,clicks,actions,action_values,ctr,cpm&date_preset=this_month&access_token=${accessToken}`;
          
          const insightsResponse = await fetch(insightsUrl);
          const insightsData = await insightsResponse.json();
          const monthInsights = insightsData.data?.[0] || {};

          // Get today's spend
          const todayUrl = `https://graph.facebook.com/v21.0/${campaign.id}/insights?` +
            `fields=spend&date_preset=today&access_token=${accessToken}`;
          
          const todayResponse = await fetch(todayUrl);
          const todayData = await todayResponse.json();
          const todayInsights = todayData.data?.[0] || {};

          // Calculate budget and pacing
          const dailyBudget = campaign.daily_budget ? parseFloat(campaign.daily_budget) / 100 : null;
          const lifetimeBudget = campaign.lifetime_budget ? parseFloat(campaign.lifetime_budget) / 100 : null;
          const budgetRemaining = campaign.budget_remaining ? parseFloat(campaign.budget_remaining) / 100 : null;
          
          const monthSpend = parseFloat(monthInsights.spend || 0);
          const todaySpend = parseFloat(todayInsights.spend || 0);
          
          // Calculate pacing
          let pacing = null;
          let pacingStatus = 'ON_TRACK';
          
          if (dailyBudget && todaySpend > 0) {
            const now = new Date();
            const hoursElapsed = now.getHours() + (now.getMinutes() / 60);
            const expectedSpend = dailyBudget * (hoursElapsed / 24);
            pacing = (todaySpend / expectedSpend) * 100;
            
            if (pacing > 120) pacingStatus = 'OVERSPENDING';
            else if (pacing < 80) pacingStatus = 'UNDERSPENDING';
          }

          return {
            id: campaign.id,
            name: campaign.name,
            status: campaign.status,
            objective: campaign.objective,
            daily_budget: dailyBudget,
            lifetime_budget: lifetimeBudget,
            budget_remaining: budgetRemaining,
            month_spend: monthSpend,
            today_spend: todaySpend,
            pacing: pacing,
            pacing_status: pacingStatus,
            impressions: parseInt(monthInsights.impressions || 0),
            clicks: parseInt(monthInsights.clicks || 0),
            ctr: parseFloat(monthInsights.ctr || 0),
            start_time: campaign.start_time,
            stop_time: campaign.stop_time
          };
        } catch (err) {
          console.error(`Error fetching campaign ${campaign.id}:`, err);
          return {
            id: campaign.id,
            name: campaign.name,
            status: campaign.status,
            objective: campaign.objective,
            daily_budget: campaign.daily_budget ? parseFloat(campaign.daily_budget) / 100 : null,
            lifetime_budget: campaign.lifetime_budget ? parseFloat(campaign.lifetime_budget) / 100 : null,
            month_spend: 0,
            today_spend: 0,
            pacing: null,
            pacing_status: 'UNKNOWN'
          };
        }
      })
    );

    // Calculate totals
    const activeCampaigns = campaignsWithSpend.filter(c => c.status === 'ACTIVE');
    const totalDailyBudget = activeCampaigns.reduce((sum, c) => sum + (c.daily_budget || 0), 0);
    const totalTodaySpend = campaignsWithSpend.reduce((sum, c) => sum + c.today_spend, 0);
    const totalMonthSpend = campaignsWithSpend.reduce((sum, c) => sum + c.month_spend, 0);

    return res.status(200).json({
      success: true,
      data: campaignsWithSpend,
      summary: {
        total_campaigns: campaignsWithSpend.length,
        active_campaigns: activeCampaigns.length,
        total_daily_budget: totalDailyBudget,
        total_today_spend: totalTodaySpend,
        total_month_spend: totalMonthSpend
      },
      meta: {
        ad_account_id
      }
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
