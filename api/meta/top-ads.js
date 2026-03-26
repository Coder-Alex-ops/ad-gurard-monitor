// Vercel Serverless Function: Get Top Performing Ads from Meta API
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
    const { ad_account_id, date_preset = 'last_7d', limit = 10, sort_by = 'roas' } = req.query;

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

    // Check if token is expired
    if (new Date(tokenData.token_expires_at) < new Date()) {
      return res.status(401).json({ error: 'Meta token expired, please reconnect' });
    }

    const accessToken = tokenData.access_token;

    // Fetch ads with insights from Meta API
    const fields = [
      'id',
      'name',
      'status',
      'creative{thumbnail_url}',
      'adset{name}',
      'campaign{name,objective}'
    ].join(',');

    const insightsFields = [
      'spend',
      'impressions',
      'clicks',
      'ctr',
      'cpm',
      'actions',
      'action_values',
      'cost_per_action_type',
      'purchase_roas',
      'quality_ranking',
      'engagement_rate_ranking',
      'conversion_rate_ranking'
    ].join(',');

    // First get ads
    const adsUrl = `https://graph.facebook.com/v21.0/act_${ad_account_id}/ads?` +
      `fields=${fields}&limit=50&status=ACTIVE&access_token=${accessToken}`;

    const adsResponse = await fetch(adsUrl);
    const adsData = await adsResponse.json();

    if (adsData.error) {
      console.error('Meta API Error:', adsData.error);
      return res.status(400).json({ error: adsData.error.message });
    }

    // Get insights for each ad
    const adsWithInsights = await Promise.all(
      (adsData.data || []).map(async (ad) => {
        try {
          const insightsUrl = `https://graph.facebook.com/v21.0/${ad.id}/insights?` +
            `fields=${insightsFields}&date_preset=${date_preset}&access_token=${accessToken}`;
          
          const insightsResponse = await fetch(insightsUrl);
          const insightsData = await insightsResponse.json();
          
          const insights = insightsData.data?.[0] || {};
          
          // Calculate metrics
          const spend = parseFloat(insights.spend || 0);
          const revenue = calculateRevenue(insights.action_values);
          const roas = spend > 0 ? revenue / spend : 0;
          const results = countResults(insights.actions, ad.campaign?.objective);
          const cpa = results > 0 ? spend / results : 0;
          
          return {
            ad_id: ad.id,
            ad_name: ad.name,
            status: ad.status,
            thumbnail_url: ad.creative?.thumbnail_url,
            adset_name: ad.adset?.name,
            campaign_name: ad.campaign?.name,
            objective: ad.campaign?.objective,
            spend: spend,
            impressions: parseInt(insights.impressions || 0),
            clicks: parseInt(insights.clicks || 0),
            ctr: parseFloat(insights.ctr || 0),
            cpm: parseFloat(insights.cpm || 0),
            results: results,
            revenue: revenue,
            roas: roas,
            cpa: cpa,
            quality_ranking: insights.quality_ranking || 'UNKNOWN',
            engagement_rate_ranking: insights.engagement_rate_ranking || 'UNKNOWN',
            conversion_rate_ranking: insights.conversion_rate_ranking || 'UNKNOWN'
          };
        } catch (err) {
          console.error(`Error fetching insights for ad ${ad.id}:`, err);
          return null;
        }
      })
    );

    // Filter out nulls and ads with no spend
    let validAds = adsWithInsights.filter(ad => ad !== null && ad.spend > 0);

    // Sort based on sort_by parameter
    validAds.sort((a, b) => {
      switch (sort_by) {
        case 'roas':
          return b.roas - a.roas;
        case 'cpa':
          return a.cpa - b.cpa; // Lower CPA is better
        case 'spend':
          return b.spend - a.spend;
        case 'results':
          return b.results - a.results;
        case 'ctr':
          return b.ctr - a.ctr;
        default:
          return b.roas - a.roas;
      }
    });

    // Limit results
    validAds = validAds.slice(0, parseInt(limit));

    return res.status(200).json({
      success: true,
      data: validAds,
      meta: {
        ad_account_id,
        date_preset,
        sort_by,
        total_count: validAds.length
      }
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Helper: Calculate total revenue from action_values
function calculateRevenue(actionValues) {
  if (!actionValues || !Array.isArray(actionValues)) return 0;
  
  const purchaseValue = actionValues.find(av => 
    av.action_type === 'purchase' || 
    av.action_type === 'omni_purchase'
  );
  
  return parseFloat(purchaseValue?.value || 0);
}

// Helper: Count results based on campaign objective
function countResults(actions, objective) {
  if (!actions || !Array.isArray(actions)) return 0;
  
  const objectiveToAction = {
    'OUTCOME_SALES': ['purchase', 'omni_purchase'],
    'OUTCOME_LEADS': ['lead', 'onsite_conversion.lead_grouped'],
    'OUTCOME_TRAFFIC': ['link_click'],
    'OUTCOME_ENGAGEMENT': ['post_engagement', 'page_engagement'],
    'OUTCOME_AWARENESS': ['reach', 'impressions'],
    'CONVERSIONS': ['purchase', 'omni_purchase', 'lead'],
    'LINK_CLICKS': ['link_click'],
    'LEAD_GENERATION': ['lead']
  };
  
  const targetActions = objectiveToAction[objective] || ['purchase', 'lead', 'link_click'];
  
  for (const actionType of targetActions) {
    const action = actions.find(a => a.action_type === actionType);
    if (action) {
      return parseInt(action.value || 0);
    }
  }
  
  return 0;
}
