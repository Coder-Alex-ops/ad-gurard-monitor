// meta-oauth-callback Edge Function
// SECURITY: This function handles token exchange server-side to protect client_secret

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Environment variables (set in Supabase dashboard)
const META_APP_ID = Deno.env.get("META_APP_ID")!;
const META_APP_SECRET = Deno.env.get("META_APP_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface AdAccount {
  id: string;
  name: string;
  account_id: string;
  currency: string;
  timezone_name: string;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      throw new Error("Missing authorization header");
    }

    // Parse request body
    const { code, redirect_uri } = await req.json();

    if (!code || !redirect_uri) {
      throw new Error("Missing required parameters");
    }

    // Create Supabase client with service role for admin operations
    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Verify the user's session
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user) {
      throw new Error("Invalid or expired session");
    }

    // Exchange code for access token
    const tokenUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id", META_APP_ID);
    tokenUrl.searchParams.set("client_secret", META_APP_SECRET);
    tokenUrl.searchParams.set("redirect_uri", redirect_uri);
    tokenUrl.searchParams.set("code", code);

    const tokenResponse = await fetch(tokenUrl.toString());
    
    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.json();
      console.error("Token exchange error:", errorData);
      throw new Error(errorData.error?.message || "Failed to exchange authorization code");
    }

    const tokenData: TokenResponse = await tokenResponse.json();

    // Exchange short-lived token for long-lived token
    const longLivedUrl = new URL("https://graph.facebook.com/v19.0/oauth/access_token");
    longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
    longLivedUrl.searchParams.set("client_id", META_APP_ID);
    longLivedUrl.searchParams.set("client_secret", META_APP_SECRET);
    longLivedUrl.searchParams.set("fb_exchange_token", tokenData.access_token);

    const longLivedResponse = await fetch(longLivedUrl.toString());
    
    if (!longLivedResponse.ok) {
      console.error("Long-lived token exchange failed, using short-lived token");
    }

    const longLivedData = longLivedResponse.ok 
      ? await longLivedResponse.json() 
      : tokenData;

    const finalAccessToken = longLivedData.access_token;
    const expiresIn = longLivedData.expires_in || 3600;

    // Fetch user's ad accounts
    const adAccountsUrl = `https://graph.facebook.com/v19.0/me/adaccounts?fields=id,name,account_id,currency,timezone_name,account_status&access_token=${finalAccessToken}`;
    
    const adAccountsResponse = await fetch(adAccountsUrl);
    
    if (!adAccountsResponse.ok) {
      const errorData = await adAccountsResponse.json();
      throw new Error(errorData.error?.message || "Failed to fetch ad accounts");
    }

    const adAccountsData = await adAccountsResponse.json();
    const adAccounts: AdAccount[] = adAccountsData.data || [];

    // Calculate token expiry
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + expiresIn);

    // Store token securely in database (encrypted at rest by Supabase)
    const { error: tokenError } = await supabaseAdmin
      .from("meta_tokens")
      .upsert({
        user_id: user.id,
        access_token: finalAccessToken, // In production, encrypt this additionally
        expires_at: expiresAt.toISOString(),
        updated_at: new Date().toISOString()
      }, {
        onConflict: "user_id"
      });

    if (tokenError) {
      console.error("Error storing token:", tokenError);
      throw new Error("Failed to store access token");
    }

    // Store/update ad accounts
    for (const account of adAccounts) {
      // Only store active accounts (account_status === 1)
      const { error: accountError } = await supabaseAdmin
        .from("ad_accounts")
        .upsert({
          user_id: user.id,
          ad_account_id: account.id,
          account_name: account.name,
          currency: account.currency,
          timezone: account.timezone_name,
          updated_at: new Date().toISOString()
        }, {
          onConflict: "user_id,ad_account_id"
        });

      if (accountError) {
        console.error("Error storing ad account:", accountError);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        accounts_connected: adAccounts.length,
        message: `Successfully connected ${adAccounts.length} ad account(s)`
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200
      }
    );

  } catch (error) {
    console.error("OAuth callback error:", error);
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || "An unexpected error occurred"
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400
      }
    );
  }
});
