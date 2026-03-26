// Vercel Serverless Function: Meta OAuth Callback Handler
// Exchanges auth code for access token and stores securely in Supabase

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { code, user_id } = req.body;

    if (!code || !user_id) {
      return res.status(400).json({ error: 'Missing code or user_id' });
    }

    // Verify user exists
    const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(user_id);
    if (userError || !user) {
      return res.status(401).json({ error: 'Invalid user' });
    }

    // Exchange code for access token
    const tokenUrl = 'https://graph.facebook.com/v21.0/oauth/access_token';
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri: `${process.env.VERCEL_URL || 'https://ad-gurard-monitor.vercel.app'}/auth-callback.html`,
      code: code
    });

    const tokenResponse = await fetch(`${tokenUrl}?${params}`);
    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      console.error('Meta token error:', tokenData.error);
      return res.status(400).json({ error: tokenData.error.message });
    }

    const shortLivedToken = tokenData.access_token;

    // Exchange for long-lived token (60 days)
    const longLivedParams = new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: shortLivedToken
    });

    const longLivedResponse = await fetch(`${tokenUrl}?${longLivedParams}`);
    const longLivedData = await longLivedResponse.json();

    if (longLivedData.error) {
      console.error('Long-lived token error:', longLivedData.error);
      return res.status(400).json({ error: longLivedData.error.message });
    }

    const accessToken = longLivedData.access_token;
    const expiresIn = longLivedData.expires_in || 5184000; // Default 60 days

    // Get user info from Meta
    const meResponse = await fetch(`https://graph.facebook.com/v21.0/me?fields=id,name,email&access_token=${accessToken}`);
    const meData = await meResponse.json();

    // Calculate expiration date
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + expiresIn);

    // Store token in Supabase (upsert - update if exists)
    const { error: insertError } = await supabase
      .from('meta_tokens')
      .upsert({
        user_id: user_id,
        access_token: accessToken,
        token_expires_at: expiresAt.toISOString(),
        meta_user_id: meData.id,
        meta_user_name: meData.name,
        meta_user_email: meData.email,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id'
      });

    if (insertError) {
      console.error('Supabase insert error:', insertError);
      return res.status(500).json({ error: 'Failed to store token' });
    }

    // Don't return the actual token to the client!
    return res.status(200).json({
      success: true,
      message: 'Meta account connected successfully',
      meta_user: {
        id: meData.id,
        name: meData.name
      },
      expires_at: expiresAt.toISOString()
    });

  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
