# ad-guard-monitor
Ad budget monitoring SaaS for agencies

## Local Development Setup

### Prerequisites
- Node.js 18+
- npm

### Installation
```bash
npm install
```

### Environment Variables
Create a `.env` file with your API keys:
```env
SUPABASE_URL=your-supabase-url
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
RESEND_API_KEY=your-resend-api-key
CRON_SECRET=your-cron-secret
NOTION_API_KEY=your-notion-api-key
NOTION_BLOG_DATABASE_ID=your-notion-database-id
```

### Running Locally

1. **Start the development server:**
   ```bash
   node dev-server.js
   ```
   Server will run at http://localhost:3000

2. **Test the dashboard:**
   Open http://localhost:3000/test-dashboard.html in your browser

3. **Test the APIs:**
   ```bash
   node test-app.js
   ```

4. **Test alert notifications:**
   ```bash
   node test-alert.js
   ```

### Available Endpoints (Mock)
- `GET /api/meta` - Get ad accounts
- `GET /api/meta/campaigns?account_id=...` - Get campaigns
- `POST /api/send-alert` - Send alert notification
- `POST /api/auth/login` - Mock login

### Production Deployment
The app is configured for Vercel deployment with serverless functions.
