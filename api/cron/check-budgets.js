import { createClient } from 'redis';
import { Resend } from 'resend';

export const config = {
    // Run at 9:00 AM and 6:00 PM UTC every day
    cron: '0 9,18 * * *'
};

export default async function handler(req, res) {
    // Verify this is a cron request (Vercel sends this header)
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        // Also allow manual trigger for testing
        if (req.query.secret !== process.env.CRON_SECRET && process.env.CRON_SECRET) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }

    const redis = createClient({ url: process.env.ad_monitor_kv_REDIS_URL });
    const resend = new Resend(process.env.RESEND_API_KEY);
    
    const results = {
        checked: 0,
        alerts: 0,
        errors: []
    };

    try {
        await redis.connect();
        
        // Get all users with notifications enabled
        const userIds = await redis.sMembers('notification_users');
        console.log(`Found ${userIds.length} users with notifications enabled`);
        
        for (const userId of userIds) {
            try {
                // Get user's notification settings
                const settingsData = await redis.get(`notifications:${userId}`);
                if (!settingsData) {
                    console.log(`No settings found for user ${userId}`);
                    continue;
                }
                
                const settings = JSON.parse(settingsData);
                
                // Check if token is expired
                if (settings.tokenExpiresAt && settings.tokenExpiresAt < Date.now()) {
                    console.log(`Token expired for user ${userId}`);
                    continue;
                }
                
                if (!settings.email || !settings.accessToken) {
                    console.log(`Missing email or token for user ${userId}`);
                    continue;
                }
                
                // Check campaigns for each account
                for (const accountId of (settings.accounts || [])) {
                    results.checked++;
                    
                    try {
                        const alerts = await checkAccountCampaigns(
                            accountId, 
                            settings.accessToken, 
                            settings.budgets || {}
                        );
                        
                        // Send alerts
                        for (const alert of alerts) {
                            const sent = await sendAlertEmail(resend, settings.email, alert, redis, userId);
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
                console.error(`Error processing user ${userId}:`, userError.message);
                results.errors.push(`User ${userId}: ${userError.message}`);
            }
        }
        
        await redis.disconnect();
        
        return res.status(200).json({ 
            success: true, 
            message: `Checked ${results.checked} accounts, sent ${results.alerts} alerts`,
            results 
        });
        
    } catch (error) {
        console.error('Cron job error:', error);
        await redis.disconnect().catch(() => {});
        return res.status(500).json({ error: error.message, results });
    }
}

async function checkAccountCampaigns(accountId, accessToken, budgets) {
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
        
        const budgetInfo = budgets[campaign.id] || {};
        const pacing = calculatePacing(campaign, budgetInfo, periodStart, periodEnd, now);
        
        if (pacing && pacing.budget > 0) {
            if (pacing.pacingPercent > 105) {
                alerts.push({
                    type: 'overspending',
                    campaignId: campaign.id,
                    campaignName: campaign.name,
                    accountId: accountId,
                    currentSpend: pacing.periodSpend,
                    expectedSpend: pacing.expectedToDate,
                    pacingPercent: pacing.pacingPercent
                });
            } else if (pacing.pacingPercent < 80) {
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
    // Get spend from insights
    const spend = campaign.insights?.data?.[0]?.spend || 0;
    const periodSpend = parseFloat(spend);
    
    // Determine daily budget
    let dailyBudget = 0;
    
    if (budgetInfo.mediaPlanBudget && budgetInfo.period) {
        // Use media plan budget
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
    } else if (campaign.daily_budget) {
        dailyBudget = parseFloat(campaign.daily_budget) / 100; // Meta returns cents
    }
    
    if (dailyBudget <= 0) {
        return null;
    }
    
    // Calculate days active in period
    const campaignStart = campaign.start_time ? new Date(campaign.start_time) : periodStart;
    const effectiveStart = campaignStart > periodStart ? campaignStart : periodStart;
    const effectiveEnd = now < periodEnd ? now : periodEnd;
    
    const daysActive = Math.max(1, Math.ceil((effectiveEnd - effectiveStart) / (1000 * 60 * 60 * 24)) + 1);
    
    // Calculate expected spend
    const expectedToDate = dailyBudget * daysActive;
    
    // Calculate pacing percentage
    const pacingPercent = expectedToDate > 0 ? (periodSpend / expectedToDate) * 100 : 0;
    
    return {
        budget: dailyBudget,
        periodSpend,
        expectedToDate,
        pacingPercent
    };
}

async function sendAlertEmail(resend, email, alert, redis, userId) {
    // Check if we already sent this alert today
    const alertKey = `alert_sent:${userId}:${alert.campaignId}:${alert.type}:${new Date().toDateString()}`;
    const alreadySent = await redis.get(alertKey);
    
    if (alreadySent) {
        console.log(`Alert already sent today: ${alertKey}`);
        return false;
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
        
        // Mark alert as sent (expires after 24 hours)
        await redis.set(alertKey, '1', { EX: 86400 });
        console.log(`Alert sent: ${alert.campaignName} - ${alert.type}`);
        return true;
        
    } catch (error) {
        console.error('Failed to send email:', error);
        return false;
    }
}
