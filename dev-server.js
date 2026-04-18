// Simple development server for testing
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Mock API endpoints for testing
app.get('/api/meta', (req, res) => {
  res.json({
    success: true,
    accounts: [
      {
        id: 'act_123456789',
        account_id: '123456789',
        name: 'Test Ad Account',
        account_status: 'ACTIVE',
        currency: 'EUR',
        timezone: 'Europe/Sofia',
        spend_cap: 100000, // 1000 EUR
        amount_spent: 75000   // 750 EUR
      }
    ]
  });
});

app.get('/api/meta/campaigns', (req, res) => {
  const { account_id } = req.query;
  res.json({
    success: true,
    campaigns: [
      {
        id: '23851234567890123',
        name: 'Test Campaign',
        status: 'ACTIVE',
        effective_status: 'ACTIVE',
        objective: 'CONVERSIONS',
        daily_budget: 5000, // 50 EUR
        lifetime_budget: null,
        budget_remaining: null,
        created_time: '2024-01-01T00:00:00+0000',
        spend: 125.50,
        impressions: 15420,
        clicks: 234,
        ctr: 1.52,
        reach: 12890,
        conversions: 12,
        cpc: 0.54,
        cpm: 8.12,
        spend_today: 25.30,
        pacing_percent: 95,
        pacing_status: 'on_track'
      }
    ],
    date_range: { since: '2024-04-17', until: '2024-04-17', preset: 'today' },
    summary: {
      total: 1,
      active: 1,
      paused: 0,
      total_spend: 125.50,
      total_impressions: 15420,
      total_clicks: 234,
      total_conversions: 12,
      avg_ctr: 1.52,
      avg_cpc: 0.54
    }
  });
});

app.post('/api/send-alert', (req, res) => {
  console.log('Mock alert sent:', req.body);
  res.json({
    success: true,
    messageId: 'mock-message-id-' + Date.now(),
    note: 'This is a mock response. In production, this would send a real email.'
  });
});

// Mock auth endpoints
app.post('/api/auth/login', (req, res) => {
  res.json({
    success: true,
    user: { id: 'test-user-id', email: 'test@example.com' },
    session: { access_token: 'mock-token' }
  });
});

app.listen(port, () => {
  console.log(`Development server running at http://localhost:${port}`);
  console.log('Available endpoints:');
  console.log('  GET  /api/meta - Get ad accounts');
  console.log('  GET  /api/meta/campaigns?account_id=... - Get campaigns');
  console.log('  POST /api/send-alert - Send alert notification');
  console.log('  POST /api/auth/login - Mock login');
});