// Vercel Serverless Function: Check Meta Connection Status
// Returns whether user has a valid Meta connection without exposing tokens

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

    // Check if user has Meta token
    const { data: tokenData, error: tokenError } = await supabase
      .from('meta_tokens')
      .select('token_expires_at, meta_user_id, meta_user_name, updated_at')
      .eq('user_id', user.id)
      .single();

    if (tokenError || !tokenData) {
      return res.status(200).json({
        connected: false,
        message: 'Meta account not connected'
      });
    }

    // Check if token is expired
    const isExpired = new Date(tokenData.token_expires_at) < new Date();
    
    // Calculate days until expiration
    const expiresAt = new Date(tokenData.token_expires_at);
    const now = new Date();
    const daysUntilExpiry = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));

    return res.status(200).json({
      connected: !isExpired,
      expired: isExpired,
      meta_user: {
        id: tokenData.meta_user_id,
        name: tokenData.meta_user_name
      },
      expires_at: tokenData.token_expires_at,
      days_until_expiry: isExpired ? 0 : daysUntilExpiry,
      last_updated: tokenData.updated_at,
      needs_refresh: daysUntilExpiry <= 7 // Warn if expiring within 7 days
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
