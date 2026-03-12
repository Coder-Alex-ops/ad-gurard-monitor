import { Resend } from 'resend';

export default async function handler(req, res) {
    // Only allow POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const resend = new Resend(process.env.RESEND_API_KEY);

    try {
        const { to, alertType, campaignName, currentSpend, expectedSpend, pacingPercent, accountName } = req.body;

        // Validate required fields
        if (!to || !alertType || !campaignName) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Build email content based on alert type
        let subject, htmlContent;

        if (alertType === 'overspending') {
            subject = `⚠️ Overspending Alert: ${campaignName}`;
            htmlContent = `
                <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 30px; border-radius: 16px 16px 0 0;">
                        <h1 style="color: white; margin: 0; font-size: 24px;">⚠️ Overspending Alert</h1>
                    </div>
                    <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 16px 16px;">
                        <p style="color: #374151; font-size: 16px; margin-bottom: 20px;">
                            Campaign <strong>"${campaignName}"</strong> is overspending!
                        </p>
                        <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
                            <table style="width: 100%; border-collapse: collapse;">
                                <tr>
                                    <td style="padding: 8px 0; color: #6b7280;">Account:</td>
                                    <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">${accountName || 'N/A'}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #6b7280;">Current Spend:</td>
                                    <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">€${parseFloat(currentSpend).toFixed(2)}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #6b7280;">Expected to Date:</td>
                                    <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">€${parseFloat(expectedSpend).toFixed(2)}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #6b7280;">Pacing:</td>
                                    <td style="padding: 8px 0; color: #dc2626; font-weight: 700; text-align: right;">${parseFloat(pacingPercent).toFixed(1)}%</td>
                                </tr>
                            </table>
                        </div>
                        <a href="https://ad-gurard-monitor.vercel.app/dashboard.html" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                            View Dashboard
                        </a>
                    </div>
                    <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 20px;">
                        AdGuard Budget Monitor • Automated Alert
                    </p>
                </div>
            `;
        } else if (alertType === 'severely-underspending') {
            subject = `📉 Severely Underspending: ${campaignName}`;
            htmlContent = `
                <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 30px; border-radius: 16px 16px 0 0;">
                        <h1 style="color: white; margin: 0; font-size: 24px;">📉 Severely Underspending</h1>
                    </div>
                    <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 16px 16px;">
                        <p style="color: #374151; font-size: 16px; margin-bottom: 20px;">
                            Campaign <strong>"${campaignName}"</strong> is severely underspending!
                        </p>
                        <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
                            <table style="width: 100%; border-collapse: collapse;">
                                <tr>
                                    <td style="padding: 8px 0; color: #6b7280;">Account:</td>
                                    <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">${accountName || 'N/A'}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #6b7280;">Current Spend:</td>
                                    <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">€${parseFloat(currentSpend).toFixed(2)}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #6b7280;">Expected to Date:</td>
                                    <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">€${parseFloat(expectedSpend).toFixed(2)}</td>
                                </tr>
                                <tr>
                                    <td style="padding: 8px 0; color: #6b7280;">Pacing:</td>
                                    <td style="padding: 8px 0; color: #d97706; font-weight: 700; text-align: right;">${parseFloat(pacingPercent).toFixed(1)}%</td>
                                </tr>
                            </table>
                        </div>
                        <a href="https://ad-gurard-monitor.vercel.app/dashboard.html" style="display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                            View Dashboard
                        </a>
                    </div>
                    <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 20px;">
                        AdGuard Budget Monitor • Automated Alert
                    </p>
                </div>
            `;
        } else {
            return res.status(400).json({ error: 'Invalid alert type' });
        }

        // Send email
        const { data, error } = await resend.emails.send({
            from: 'AdGuard Monitor <onboarding@resend.dev>',
            to: [to],
            subject: subject,
            html: htmlContent,
        });

        if (error) {
            console.error('Resend error:', error);
            return res.status(500).json({ error: error.message });
        }

        return res.status(200).json({ success: true, messageId: data.id });

    } catch (error) {
        console.error('Email send error:', error);
        return res.status(500).json({ error: 'Failed to send email' });
    }
}
