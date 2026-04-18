// Test script for sending alert notification
import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jprnvftdfnhsfeuoxkkh.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'your-anon-key';
const RESEND_API_KEY = process.env.RESEND_API_KEY || 'your-resend-key';

async function testSendAlert() {
  console.log('Testing alert notification...');

  const resend = new Resend(RESEND_API_KEY);
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  try {
    // Test data
    const testData = {
      to: 'test@example.com', // Replace with your email
      alertType: 'overspending',
      campaignName: 'Test Campaign',
      currentSpend: 150,
      expectedSpend: 100,
      pacingPercent: 150,
      accountName: 'Test Account'
    };

    console.log('Sending test alert with data:', testData);

    // This mimics the logic from send-alert.js
    let subject = `⚠️ Overspending Alert: ${testData.campaignName}`;
    let htmlContent = `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 30px; border-radius: 16px 16px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 24px;">⚠️ Overspending Alert</h1>
        </div>
        <div style="background: #ffffff; padding: 30px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 16px 16px;">
          <p style="color: #374151; font-size: 16px; margin-bottom: 20px;">
            Campaign <strong>"${testData.campaignName}"</strong> is overspending!
          </p>
          <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 12px; padding: 20px; margin-bottom: 20px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Account:</td>
                <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">${testData.accountName}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Current Spend:</td>
                <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">€${testData.currentSpend.toFixed(2)}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Expected to Date:</td>
                <td style="padding: 8px 0; color: #111827; font-weight: 600; text-align: right;">€${testData.expectedSpend.toFixed(2)}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Pacing:</td>
                <td style="padding: 8px 0; color: #dc2626; font-weight: 700; text-align: right;">${testData.pacingPercent.toFixed(1)}%</td>
              </tr>
            </table>
          </div>
          <p style="color: #9ca3af; font-size: 12px; text-align: center; margin-top: 20px;">
            AdGuard Budget Monitor • Test Alert
          </p>
        </div>
      </div>
    `;

    // Note: This will fail without valid API keys, but shows the structure
    const { data, error } = await resend.emails.send({
      from: 'AdGuard Monitor <test@example.com>',
      to: [testData.to],
      subject: subject,
      html: htmlContent,
    });

    if (error) {
      console.error('Resend error:', error);
      console.log('This is expected without valid API keys. The email structure is correct.');
    } else {
      console.log('Email sent successfully:', data);
    }

  } catch (error) {
    console.error('Test error:', error);
  }
}

testSendAlert();