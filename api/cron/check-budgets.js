import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

export const config = {
    // Run at 09:00 and 18:00 UTC (11:00 and 20:00 Bulgarian time) every day
    cron: '0 9,18 * * *'
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
    
    const results = {
        accountBudgetsChecked: 0,
        alertsSent: 0,
        errors: [],
        debug: []
    };

    try {
        // ========================================
        // Check Account-Level Budgets
        // ========================================
        
        // Get all account budgets with their notification settings
        const { data: accountBudgets, error: abError } = await supabase
            .from('account_budgets')
            .select('*')
            .eq('alerts_enabled', true);
        
        if (abError) {
            console.error('Error fetching account budgets:', abError);
            results.errors.push('Failed to fetch account budgets');
            return res.status(500).json({ error: 'Failed to fetch account budgets', results });
        }
        
        console.log(`Found ${accountBudgets?.length || 0} account budgets to check`);
        
        for (const budget of (accountBudgets || [])) {
            try {
                results.accountBudgetsChecked++;
                
                // Get notification settings for this user
                const { data: notifSettings } = await supabase
                    .from('notification_settings')
                    .select('*')
                    .eq('user_id', budget.user_id)
                    .eq('enabled', true)
                    .single();
                
                if (!notifSettings?.email) {
                    console.log(`No notification email for user ${budget.user_id}`);
                    continue;
                }
                
                // Get user's Meta access token from organization
                const { data: org } = await supabase
                    .from('organizations')
                    .select('meta_access_token')
                    .eq('owner_id', budget.user_id)
                    .single();
                
                let accessToken = org?.meta_access_token;
                
                // Also try meta_connections table
                if (!accessToken) {
                    const { data: metaConn } = await supabase
                        .from('meta_connections')
                        .select('access_token')
                        .eq('user_id', budget.user_id)
                        .single();
                    accessToken = metaConn?.access_token;
                }
                
                if (!accessToken) {
                    console.log(`No access token for user ${budget.user_id}`);
                    continue;
                }
                
                // Check if within budget period
                const now = new Date();
                const todayStr = now.toISOString().split('T')[0]; // YYYY-MM-DD in UTC
                const today = new Date(todayStr); // Midnight UTC
                const periodStart = new Date(budget.period_start);
                const periodEnd = new Date(budget.period_end);
                
                console.log(`Date check: today=${todayStr}, period=${budget.period_start} to ${budget.period_end}`);
                
                if (today < periodStart || today > periodEnd) {
                    console.log(`Budget period not active for ${budget.ad_account_name}`);
                    continue;
                }
                
                // Fetch actual spend from Meta API
                const timeRange = JSON.stringify({
                    since: budget.period_start,
                    until: todayStr
                });
                
                const insightsUrl = `https://graph.facebook.com/v19.0/${budget.ad_account_id}/insights?fields=spend&time_range=${timeRange}&access_token=${accessToken}`;
                const insightsRes = await fetch(insightsUrl);
                const insightsData = await insightsRes.json();
                
                if (insightsData.error) {
                    console.error(`Meta API error for ${budget.ad_account_id}:`, insightsData.error.message);
                    results.errors.push(`Meta API error for ${budget.ad_account_name}: ${insightsData.error.message}`);
                    continue;
                }
                
                const actualSpend = parseFloat(insightsData.data?.[0]?.spend || 0);
                
                // Calculate pacing
                const totalDays = Math.ceil((periodEnd - periodStart) / (1000 * 60 * 60 * 24)) + 1;
                const elapsedDays = Math.ceil((today - periodStart) / (1000 * 60 * 60 * 24)) + 1;
                const dailyBudget = parseFloat(budget.monthly_budget) / totalDays;
                const expectedSpend = dailyBudget * elapsedDays;
                const pacingPercent = expectedSpend > 0 ? (actualSpend / expectedSpend) * 100 : 0;
                
                console.log(`${budget.ad_account_name}: Spend €${actualSpend.toFixed(2)}, Expected €${expectedSpend.toFixed(2)}, Pacing ${pacingPercent.toFixed(1)}%`);
                
                // Check thresholds
                const underspendThreshold = budget.alert_underspend_threshold || 50;
                const overspendThreshold = budget.alert_overspend_threshold || 120;
                
                // Add debug info
                results.debug.push({
                    account: budget.ad_account_name,
                    actualSpend,
                    expectedSpend,
                    pacingPercent: pacingPercent.toFixed(1),
                    underspendThreshold,
                    overspendThreshold,
                    shouldAlert: pacingPercent > overspendThreshold || pacingPercent < underspendThreshold
                });
                
                console.log(`Thresholds: under=${underspendThreshold}%, over=${overspendThreshold}%`);
                
                let alertType = null;
                
                if (pacingPercent > overspendThreshold && notifSettings.alert_overspending !== false) {
                    alertType = 'overspending';
                    console.log(`🚨 OVERSPEND DETECTED: ${pacingPercent.toFixed(1)}% > ${overspendThreshold}%`);
                } else if (pacingPercent < underspendThreshold && actualSpend > 0.01 && notifSettings.alert_underspending !== false) {
                    alertType = 'severely-underspending';
                    console.log(`🚨 UNDERSPEND DETECTED: ${pacingPercent.toFixed(1)}% < ${underspendThreshold}%`);
                } else {
                    console.log(`✅ ON TRACK: ${underspendThreshold}% <= ${pacingPercent.toFixed(1)}% <= ${overspendThreshold}%`);
                }
                
                if (alertType) {
                    console.log(`🚨 Alert needed: ${budget.ad_account_name} - ${alertType} (${pacingPercent.toFixed(1)}%)`);
                    
                    const sent = await sendAccountBudgetAlert(resend, {
                        email: notifSettings.email,
                        alertType,
                        accountName: budget.ad_account_name,
                        actualSpend,
                        expectedSpend,
                        pacingPercent,
                        monthlyBudget: budget.monthly_budget,
                        periodStart: budget.period_start,
                        periodEnd: budget.period_end,
                        elapsedDays,
                        totalDays
                    });
                    
                    if (sent) {
                        results.alertsSent++;
                    }
                } else {
                    console.log(`✅ ${budget.ad_account_name} is on track (${pacingPercent.toFixed(1)}%)`);
                }
                
            } catch (error) {
                console.error(`Error checking account budget ${budget.ad_account_id}:`, error.message);
                results.errors.push(`Account ${budget.ad_account_id}: ${error.message}`);
            }
        }
        
        return res.status(200).json({ 
            success: true, 
            message: `Checked ${results.accountBudgetsChecked} account budgets, sent ${results.alertsSent} alerts`,
            results,
            debug: results.debug || []
        });
        
    } catch (error) {
        console.error('Cron job error:', error);
        return res.status(500).json({ error: error.message, results });
    }
}

async function sendAccountBudgetAlert(resend, data) {
    const { email, alertType, accountName, actualSpend, expectedSpend, pacingPercent, monthlyBudget, periodStart, periodEnd, elapsedDays, totalDays } = data;
    
    const isOverspending = alertType === 'overspending';
    const color = isOverspending ? '#ef4444' : '#f59e0b';
    const emoji = isOverspending ? '⚠️' : '📉';
    const title = isOverspending ? 'Overspending Alert' : 'Underspending Alert';
    const subject = `${emoji} ${title}: ${accountName}`;
    
    const htmlContent = `
        <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, ${color} 0%, ${isOverspending ? '#dc2626' : '#d97706'} 100%); padding: 30px; border-radius: 16px 16px 0 0;">
                <h1 style="color: white; margin: 0; font-size: 24px;">${emoji} ${title}</h1>
                <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0;">Account Budget Alert</p>
            </div>
            <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 16px 16px;">
                <p style="color: #374151; font-size: 16px; margin-bottom: 20px;">
                    Account <strong>"${accountName}"</strong> is ${isOverspending ? 'overspending' : 'underspending'}!
                </p>
                
                <div style="background: ${isOverspending ? '#fef2f2' : '#fffbeb'}; border: 1px solid ${isOverspending ? '#fecaca' : '#fde68a'}; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
                    <table style="width: 100%; border-collapse: collapse;">
                        <tr>
                            <td style="padding: 10px 0; color: #6b7280;">Monthly Budget:</td>
                            <td style="padding: 10px 0; color: #111827; font-weight: 600; text-align: right;">€${parseFloat(monthlyBudget).toFixed(2)}</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px 0; color: #6b7280;">Period:</td>
                            <td style="padding: 10px 0; color: #111827; font-weight: 600; text-align: right;">${periodStart} to ${periodEnd}</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px 0; color: #6b7280;">Day:</td>
                            <td style="padding: 10px 0; color: #111827; font-weight: 600; text-align: right;">${elapsedDays} of ${totalDays}</td>
                        </tr>
                        <tr style="border-top: 1px solid ${isOverspending ? '#fecaca' : '#fde68a'};">
                            <td style="padding: 10px 0; color: #6b7280;">Current Spend:</td>
                            <td style="padding: 10px 0; color: #111827; font-weight: 600; text-align: right;">€${actualSpend.toFixed(2)}</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px 0; color: #6b7280;">Expected to Date:</td>
                            <td style="padding: 10px 0; color: #111827; font-weight: 600; text-align: right;">€${expectedSpend.toFixed(2)}</td>
                        </tr>
                        <tr>
                            <td style="padding: 10px 0; color: #6b7280;">Pacing:</td>
                            <td style="padding: 10px 0; color: ${color}; font-weight: 700; text-align: right; font-size: 18px;">${pacingPercent.toFixed(1)}%</td>
                        </tr>
                    </table>
                </div>
                
                <a href="https://ad-gurard-monitor.vercel.app/dashboard" style="display: inline-block; background: #4f46e5; color: white; padding: 14px 28px; border-radius: 10px; text-decoration: none; font-weight: 600;">
                    View Dashboard →
                </a>
            </div>
            <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 20px;">
                AdGuardian • Automated Budget Alert
            </p>
        </div>
    `;
    
    try {
        const { error } = await resend.emails.send({
            from: 'AdGuardian <onboarding@resend.dev>',
            to: [email],
            subject: subject,
            html: htmlContent,
        });
        
        if (error) {
            console.error('Email send error:', error);
            return false;
        }
        
        console.log(`✅ Alert sent to ${email}: ${accountName} - ${alertType}`);
        return true;
        
    } catch (error) {
        console.error('Failed to send email:', error);
        return false;
    }
}
