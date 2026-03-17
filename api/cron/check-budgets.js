import { createClient } from '@supabase/supabase-js';
import { createClient as createRedisClient } from 'redis';
import { Resend } from 'resend';

export const config = {
    // Run at 18:00 UTC (20:00 Bulgarian time) every day
    cron: '0 18 * * *'
};

// Initialize Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
    // Verify this is a cron request
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        if (req.query.secret !== process.env.CRON_SECRET && process.env.CRON_SECRET) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    
    // Redis for deduplication
    let redis = null;
    try {
        redis = createRedisClient({ url: process.env.ad_monitor_kv_REDIS_URL });
        await redis.connect();
    } catch (e) {
        console.log('Redis not available, continuing without deduplication');
    }
    
    const results = {
        checked: 0,
        alerts: 0,
        skipped: 0,
        errors: []
    };

    try {
        // Get all users with notifications enabled from Supabase
        const { data: notificationUsers, error: notifError } = await supabase
            .from('notification_settings')
            .select('*')
            .eq('enabled', true);
        
        if (notifError) throw notifError;
        
        console.log(`Found ${notificationUsers?.length || 0} users with notifications enabled`);
        
        for (const userSettings of (notificationUsers || [])) {
            try {
                const userId = userSettings.user_id;
                const email = userSettings.email;
                
                if (!email) {
                    console.log(`No email for user ${userId}`);
                    continue;
                }
                
                // Get user's Meta connection (access token)
                const { data: metaConnection, error: metaError } = await supabase
                    .from('meta_connections')
                    .select('*')
                    .eq('user_id', userId)
                    .single();
                
                // If no Meta connection in Supabase, try Redis (backwards compatibility)
                let accessToken = metaConnection?.access_token;
                let adAccounts = metaConnection?.ad_accounts || [];
                
                if (!accessToken && redis) {
                    const redisData = await redis.get(`notifications:${userId}`);
                    if (redisData) {
                        const parsed = JSON.parse(redisData);
                        accessToken = parsed.accessToken;
                        adAccounts = parsed.accounts || [];
                    }
                }
                
                if (!accessToken) {
                    console.log(`No access token for user ${userId}`);
                    continue;
                }
                
                // Get user's budgets from Supabase - ONLY these campaigns will be checked
                const { data: budgetsData, error: budgetsError } = await supabase
                    .from('campaign_budgets')
                    .select('*')
                    .eq('user_id', userId);
                
                if (budgetsError) throw budgetsError;
                
                // Convert to object format
                const budgets = {};
                (budgetsData || []).forEach(row => {
                    budgets[row.campaign_id] = {
                        mediaPlanBudget: row.media_plan_budget,
                        period: row.budget_period
                    };
                });
                
                // If no budgets set, skip this user entirely
                if (Object.keys(budgets).length === 0) {
                    console.log(`No budgets set for user ${userId}, skipping`);
                    results.skipped++;
                    continue;
                }
                
                // Get ad accounts if not stored
                if (adAccounts.length === 0) {
                    const accountsUrl = `https://graph.facebook.com/v19.0/me/adaccounts?fields=account_id&access_token=${accessToken}`;
                    const accountsRes = await fetch(accountsUrl);
                    const accountsData = await accountsRes.json();
                    
                    if (accountsData.data) {
                        adAccounts = accountsData.data.map(a => a.account_id);
                    }
                }
                
                // Check campaigns for each account
                for (const accountId of adAccounts) {
                    results.checked++;
                    
                    try {
                        const alerts = await checkAccountCampaigns(
                            accountId, 
                            accessToken, 
                            budgets,
                            userSettings
                        );
                        
                        // Send alerts
                        for (const alert of alerts) {
                            const sent = await sendAlertEmail(resend, email, alert, redis, userId);
                            if (sent) {
                                results.alerts++;
                            }
                        }
                    } catch (accountError) {
                        console.error(`Error checking account ${accountId}:`, accountError.message);
                        results.errors.push(`Account ${accountId}: ${accountError.message}`);
                    }
                }
                
            } catch (userError) {
                console.error(`Error processing user:`, userError.message);
                results.errors.push(`User error: ${userError.message}`);
            }
        }
        
        if (redis) await redis.disconnect();
        
        return res.status(200).json({ 
            success: true, 
            message: `Checked ${results.checked} accounts, sent ${results.alerts} alerts, skipped ${results.skipped} users without budgets`,
            results 
        });
        
    } catch (error) {
        console.error('Cron job error:', error);
        if (redis) await redis.disconnect().catch(() => {});
        return res.status(500).json({ error: error.message, results });
    }
}

async function checkAccountCampaigns(accountId, accessToken, budgets, userSettings) {
    const alerts = [];
    
    // Get date range for this month
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    
    const timeRange = JSON.stringify({
        since: periodStart.toISOString().split('T')[0],
        until: now.toISOString().split('T')[0]
    });
    
    // Fetch campaigns with insights
    const url = `https://graph.facebook.com/v19.0/act_${accountId}/campaigns?` + 
        `fields=id,name,status,daily_budget,lifetime_budget,start_time,stop_time,` +
        `insights.time_range(${timeRange}){spend,impressions}` +
        `&access_token=${accessToken}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.error) {
        throw new Error(data.error.message);
    }
    
    const campaigns = data.data || [];
    
    for (const campaign of campaigns) {
        // Only check active campaigns
        if (campaign.status !== 'ACTIVE') continue;
        
        // CRITICAL: Only check campaigns with Media Plan Budget set by user
        // Skip campaigns without a budget entry in our database
        const budgetInfo = budgets[campaign.id];
        if (!budgetInfo || !budgetInfo.mediaPlanBudget) {
            continue; // No Media Plan Budget set - skip this campaign
        }
        
        const pacing = calculatePacing(campaign, budgetInfo, periodStart, periodEnd, now);
        
        if (pacing && pacing.budget > 0) {
            // Check for overspending
            if (pacing.pacingPercent > 105 && userSettings.alert_overspending !== false) {
                alerts.push({
                    type: 'overspending',
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    accountId: accountId,
                    currentSpend: pacing.periodSpend,
                    expectedSpend: pacing.expectedToDate,
                    pacingPercent: pacing.pacingPercent
                });
            } 
            // Check for underspending (only if spend > €0.01)
            else if (pacing.pacingPercent < 80 && pacing.periodSpend > 0.01 && userSettings.alert_underspending !== false) {
                alerts.push({
                    type: 'severely-underspending',
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    accountId: accountId,
                    currentSpend: pacing.periodSpend,
                    expectedSpend: pacing.expectedToDate,
                    pacingPercent: pacing.pacingPercent
                });
            }
        }
    }
    
    return alerts;
}

function calculatePacing(campaign, budgetInfo, periodStart, periodEnd, now) {
    const spend = campaign.insights?.data?.[0]?.spend || 0;
    const periodSpend = parseFloat(spend);
    
    let dailyBudget = 0;
    
    // ONLY use Media Plan Budget - NO FALLBACK to Meta's daily_budget
    if (budgetInfo.mediaPlanBudget && budgetInfo.period) {
        const mpBudget = budgetInfo.mediaPlanBudget;
        switch (budgetInfo.period) {
            case 'daily':
                dailyBudget = mpBudget;
                break;
            case 'weekly':
                dailyBudget = mpBudget / 7;
                break;
            case 'monthly':
                const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
                dailyBudget = mpBudget / daysInMonth;
                break;
            case 'total':
                const campaignStart = campaign.start_time ? new Date(campaign.start_time) : periodStart;
                const campaignEnd = campaign.stop_time ? new Date(campaign.stop_time) : periodEnd;
                const totalDays = Math.ceil((campaignEnd - campaignStart) / (1000 * 60 * 60 * 24)) + 1;
                dailyBudget = mpBudget / totalDays;
                break;
        }
    }
    
    // If no valid daily budget calculated, return null (skip this campaign)
    if (dailyBudget <= 0) {
        return null;
    }
    
    const campaignStart = campaign.start_time ? new Date(campaign.start_time) : periodStart;
    const effectiveStart = campaignStart > periodStart ? campaignStart : periodStart;
    const effectiveEnd = now < periodEnd ? now : periodEnd;
    
    const daysActive = Math.max(1, Math.ceil((effectiveEnd - effectiveStart) / (1000 * 60 * 60 * 24)) + 1);
    const expectedToDate = dailyBudget * daysActive;
    const pacingPercent = expectedToDate > 0 ? (periodSpend / expectedToDate) * 100 : 0;
    
    return {
        budget: dailyBudget,
        periodSpend,
        expectedToDate,
        pacingPercent
    };
}

async function sendAlertEmail(resend, email, alert, redis, userId) {
    // Check deduplication if Redis is available
    if (redis) {
        const alertKey = `alert_sent:${userId}:${alert.campaignId}:${alert.type}:${new Date().toDateString()}`;
        const alreadySent = await redis.get(alertKey);
        
        if (alreadySent) {
            console.log(`Alert already sent today: ${alertKey}`);
            return false;
        }
    }
    
    const subject = alert.type === 'overspending' 
        ? `⚠️ Overspending Alert: ${alert.campaignName}`
        : `📉 Underspending Alert: ${alert.campaignName}`;
    
    const color = alert.type === 'overspending' ? '#ef4444' : '#f59e0b';
    const emoji = alert.type === 'overspending' ? '⚠️' : '📉';
    const title = alert.type === 'overspending' ? 'Overspending Alert' : 'Severely Underspending';
    
    const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: ${color}; padding: 20px; border-radius: 12px 12px 0 0;">
                <h1 style="color: white; margin: 0;">${emoji} ${title}</h1>
            </div>
            <div style="background: #fff; padding: 20px; border: 1px solid #e5e7eb; border-radius: 0 0 12px 12px;">
                <p>Campaign <strong>${alert.campaignName}</strong> needs attention!</p>
                <table style="width: 100%; margin: 20px 0;">
                    <tr><td style="padding: 8px 0; color: #666;">Current Spend:</td><td style="text-align: right; font-weight: bold;">€${alert.currentSpend.toFixed(2)}</td></tr>
                    <tr><td style="padding: 8px 0; color: #666;">Expected:</td><td style="text-align: right; font-weight: bold;">€${alert.expectedSpend.toFixed(2)}</td></tr>
                    <tr><td style="padding: 8px 0; color: #666;">Pacing:</td><td style="text-align: right; font-weight: bold; color: ${color};">${alert.pacingPercent.toFixed(1)}%</td></tr>
                </table>
                <a href="https://ad-gurard-monitor.vercel.app/dashboard.html" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none;">View Dashboard</a>
            </div>
            <p style="color: #999; font-size: 12px; text-align: center; margin-top: 20px;">
                AdGuard Budget Monitor • Automated Alert
            </p>
        </div>
    `;
    
    try {
        const { error } = await resend.emails.send({
            from: 'AdGuard Monitor <onboarding@resend.dev>',
            to: [email],
            subject: subject,
            html: htmlContent,
        });
        
        if (error) {
            console.error('Email send error:', error);
            return false;
        }
        
        // Mark alert as sent if Redis is available
        if (redis) {
            const alertKey = `alert_sent:${userId}:${alert.campaignId}:${alert.type}:${new Date().toDateString()}`;
            await redis.set(alertKey, '1', { EX: 86400 });
        }
        
        console.log(`Alert sent: ${alert.campaignName} - ${alert.type}`);
        return true;
        
    } catch (error) {
        console.error('Failed to send email:', error);
        return false;
    }
}
