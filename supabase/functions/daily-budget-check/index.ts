// daily-budget-check Edge Function
// Runs via cron at 20:00 BG time (18:00 UTC)
// Checks budget pacing and sends email alerts

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Environment variables
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

interface UserWithAccounts {
  user_id: string;
  email: string;
  accounts: {
    ad_account_id: string;
    account_name: string;
    daily_spend: number;
    daily_budget: number;
  }[];
  alert_threshold: number;
  email_alerts_enabled: boolean;
}

async function sendAlertEmail(
  email: string,
  alerts: { accountName: string; spend: number; budget: number; percentage: number }[]
) {
  const alertsHtml = alerts
    .map(
      (a) => `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">${a.accountName}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">€${a.spend.toFixed(2)}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">€${a.budget.toFixed(2)}</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; color: ${a.percentage > 100 ? '#ef4444' : '#f59e0b'}; font-weight: 600;">
          ${a.percentage.toFixed(0)}%
        </td>
      </tr>
    `
    )
    .join("");

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Budget Alert - AdGuard Monitor</title>
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8fafc; padding: 40px 20px;">
      <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
        <div style="padding: 32px; border-bottom: 1px solid #e2e8f0;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <div style="width: 40px; height: 40px; background: linear-gradient(135deg, #06b6d4, #0891b2); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: white; font-weight: 800; font-size: 16px;">AG</div>
            <span style="font-size: 20px; font-weight: 700; color: #0f172a;">AdGuard<span style="color: #06b6d4;">Monitor</span></span>
          </div>
        </div>
        
        <div style="padding: 32px;">
          <h1 style="margin: 0 0 8px; font-size: 24px; color: #0f172a;">⚠️ Budget Alert</h1>
          <p style="margin: 0 0 24px; color: #64748b; font-size: 16px;">
            Some of your ad accounts are approaching or exceeding their daily budget.
          </p>
          
          <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
            <thead>
              <tr style="background: #f1f5f9;">
                <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase;">Account</th>
                <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase;">Spend</th>
                <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase;">Budget</th>
                <th style="padding: 12px; text-align: left; font-size: 12px; font-weight: 600; color: #64748b; text-transform: uppercase;">Pacing</th>
              </tr>
            </thead>
            <tbody>
              ${alertsHtml}
            </tbody>
          </table>
          
          <a href="https://ad-gurard-monitor.vercel.app/dashboard.html" 
             style="display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #06b6d4, #0891b2); color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px;">
            View Dashboard
          </a>
        </div>
        
        <div style="padding: 24px 32px; background: #f8fafc; border-top: 1px solid #e2e8f0; border-radius: 0 0 12px 12px;">
          <p style="margin: 0; font-size: 13px; color: #94a3b8;">
            You're receiving this email because you have budget alerts enabled in AdGuard Monitor.
            <br>
            <a href="https://ad-gurard-monitor.vercel.app/dashboard.html#settings" style="color: #06b6d4;">Manage notification settings</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "AdGuard Monitor <alerts@adguard-monitor.com>",
      to: email,
      subject: `⚠️ Budget Alert: ${alerts.length} account(s) need attention`,
      html: html,
    }),
  });

  return response.ok;
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify cron secret
    const authHeader = req.headers.get("Authorization");
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Get all users with their accounts and settings
    const { data: users, error: usersError } = await supabaseAdmin
      .from("auth.users")
      .select("id, email");

    if (usersError) {
      throw new Error("Failed to fetch users");
    }

    let alertsSent = 0;
    let usersProcessed = 0;

    for (const user of users || []) {
      usersProcessed++;

      // Get user settings
      const { data: settings } = await supabaseAdmin
        .from("user_settings")
        .select("email_alerts_enabled, alert_threshold")
        .eq("user_id", user.id)
        .single();

      if (!settings?.email_alerts_enabled) {
        continue;
      }

      const alertThreshold = settings.alert_threshold || 80;

      // Get user's ad accounts
      const { data: accounts } = await supabaseAdmin
        .from("ad_accounts")
        .select("ad_account_id, account_name, daily_spend, daily_budget")
        .eq("user_id", user.id)
        .eq("is_active", true);

      if (!accounts || accounts.length === 0) {
        continue;
      }

      // Check for accounts exceeding threshold
      const alertAccounts: { accountName: string; spend: number; budget: number; percentage: number }[] = [];

      for (const account of accounts) {
        if (account.daily_budget <= 0) continue;

        const percentage = (account.daily_spend / account.daily_budget) * 100;

        if (percentage >= alertThreshold) {
          alertAccounts.push({
            accountName: account.account_name,
            spend: account.daily_spend,
            budget: account.daily_budget,
            percentage,
          });

          // Create alert in database
          await supabaseAdmin.from("alerts").insert({
            user_id: user.id,
            ad_account_id: account.ad_account_id,
            account_name: account.account_name,
            type: percentage > 100 ? "danger" : "warning",
            title: percentage > 100 ? "Over Budget!" : "Budget Alert",
            message: `${account.account_name} has spent ${percentage.toFixed(0)}% of daily budget (€${account.daily_spend.toFixed(2)} / €${account.daily_budget.toFixed(2)})`,
            email_sent: true,
          });
        }
      }

      // Send email if there are alerts
      if (alertAccounts.length > 0) {
        const emailSent = await sendAlertEmail(user.email, alertAccounts);
        if (emailSent) {
          alertsSent++;
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        users_processed: usersProcessed,
        alerts_sent: alertsSent,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error) {
    console.error("Daily budget check error:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || "An unexpected error occurred",
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
});
