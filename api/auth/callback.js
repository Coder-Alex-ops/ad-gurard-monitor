// Vercel Serverless Function: Meta OAuth Callback
// Записва Meta токени в Supabase (НЕ Redis)

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const { code, error, error_description } = req.query;

  // Handle OAuth errors
  if (error) {
    console.error('OAuth error:', error, error_description);
    return res.redirect('/auth-callback.html?error=' + encodeURIComponent(error_description || error));
  }

  if (!code) {
    return res.redirect('/auth-callback.html?error=' + encodeURIComponent('No authorization code'));
  }

  try {
    // Exchange code for access token
    const tokenResponse = await fetch('https://graph.facebook.com/v21.0/oauth/access_token?' + new URLSearchParams({
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      redirect_uri: `${getBaseUrl(req)}/auth-callback.html`,
      code: code
    }));

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      console.error('Token exchange error:', tokenData.error);
      return res.redirect('/auth-callback.html?error=' + encodeURIComponent(tokenData.error.message || 'Token exchange failed'));
    }

    const { access_token, expires_in } = tokenData;

    // Exchange for long-lived token
    const longTokenResponse = await fetch('https://graph.facebook.com/v21.0/oauth/access_token?' + new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID,
      client_secret: process.env.META_APP_SECRET,
      fb_exchange_token: access_token
    }));

    const longTokenData = await longTokenResponse.json();
    const longLivedToken = longTokenData.access_token || access_token;
    const tokenExpiresIn = longTokenData.expires_in || expires_in || 5184000; // ~60 days default

    // Get Meta user info
    const meResponse = await fetch(`https://graph.facebook.com/v21.0/me?access_token=${longLivedToken}`);
    const meData = await meResponse.json();

    if (meData.error) {
      console.error('Me API error:', meData.error);
      return res.redirect('/auth-callback.html?error=' + encodeURIComponent('Failed to get user info'));
    }

    const metaUserId = meData.id;

    // Get ad accounts
    const accountsResponse = await fetch(`https://graph.facebook.com/v21.0/me/adaccounts?fields=id,name,account_id,currency,account_status&access_token=${longLivedToken}`);
    const accountsData = await accountsResponse.json();
    const adAccounts = accountsData.data || [];

    // Calculate token expiry
    const tokenExpiresAt = new Date(Date.now() + tokenExpiresIn * 1000).toISOString();

    // Get user_id from Supabase session cookie
    // Since we can't easily get the Supabase session from cookies server-side,
    // we'll store with meta_user_id and let the frontend link it

    // Initialize Supabase admin client
    const supabase = createClient(
      process.env.SUPABASE_URL || 'https://jprnvftdfnhsfeuoxkkh.supabase.co',
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Upsert meta connection (insert or update if exists)
    const { data, error: dbError } = await supabase
      .from('meta_connections')
      .upsert({
        meta_user_id: metaUserId,
        access_token: longLivedToken,
        token_expires_at: tokenExpiresAt,
        ad_accounts: adAccounts,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'meta_user_id'
      })
      .select();

    if (dbError) {
      console.error('Database error:', dbError);
      // Still redirect to success - we'll link the user later
    }

    // Store meta_user_id in a cookie so frontend can link it
    res.setHeader('Set-Cookie', [
      `meta_user_id=${metaUserId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`,
      `meta_connected=true; Path=/; Secure; SameSite=Lax; Max-Age=300`
    ]);

    // Redirect to success
    return res.redirect('/auth-callback.html?success=true&accounts=' + adAccounts.length);

  } catch (err) {
    console.error('Callback error:', err);
    return res.redirect('/auth-callback.html?error=' + encodeURIComponent('Server error'));
  }
}

function getBaseUrl(req) {
  const host = req.headers.host;
  const protocol = host.includes('localhost') ? 'http' : 'https';
  return `${protocol}://${host}`;
}
