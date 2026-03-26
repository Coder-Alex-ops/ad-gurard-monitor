-- ============================================
-- AdGuard Budget Monitor v2.0 - Database Schema
-- Security-focused design with RLS
-- ============================================

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================
-- META TOKENS TABLE (Secure Token Storage)
-- ============================================
CREATE TABLE IF NOT EXISTS meta_tokens (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    access_token TEXT NOT NULL,
    token_expires_at TIMESTAMPTZ NOT NULL,
    meta_user_id TEXT,
    meta_user_name TEXT,
    meta_user_email TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id)
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_meta_tokens_user_id ON meta_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_meta_tokens_expires_at ON meta_tokens(expires_at);

-- RLS: Users can only access their own tokens
ALTER TABLE meta_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own tokens" ON meta_tokens
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tokens" ON meta_tokens
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tokens" ON meta_tokens
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own tokens" ON meta_tokens
    FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- AD ACCOUNTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS ad_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ad_account_id TEXT NOT NULL,
    account_name TEXT NOT NULL,
    currency TEXT DEFAULT 'EUR',
    timezone TEXT DEFAULT 'Europe/Sofia',
    daily_budget DECIMAL(12,2) DEFAULT 0,
    daily_spend DECIMAL(12,2) DEFAULT 0,
    active_campaigns INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, ad_account_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_ad_accounts_user_id ON ad_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_ad_accounts_ad_account_id ON ad_accounts(ad_account_id);

-- RLS
ALTER TABLE ad_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own ad accounts" ON ad_accounts
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own ad accounts" ON ad_accounts
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own ad accounts" ON ad_accounts
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own ad accounts" ON ad_accounts
    FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- CAMPAIGNS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ad_account_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    campaign_name TEXT NOT NULL,
    objective TEXT,
    status TEXT DEFAULT 'ACTIVE',
    daily_budget DECIMAL(12,2) DEFAULT 0,
    lifetime_budget DECIMAL(12,2) DEFAULT 0,
    spend_today DECIMAL(12,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, campaign_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_campaigns_user_id ON campaigns(user_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_ad_account_id ON campaigns(ad_account_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);

-- RLS
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own campaigns" ON campaigns
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own campaigns" ON campaigns
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own campaigns" ON campaigns
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own campaigns" ON campaigns
    FOR DELETE USING (auth.uid() = user_id);

-- ============================================
-- ALERTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS alerts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ad_account_id TEXT,
    account_name TEXT,
    type TEXT NOT NULL CHECK (type IN ('info', 'warning', 'danger', 'success')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    read BOOLEAN DEFAULT false,
    email_sent BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_alerts_user_id ON alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_alerts_read ON alerts(read);
CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts(created_at DESC);

-- RLS
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own alerts" ON alerts
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own alerts" ON alerts
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own alerts" ON alerts
    FOR DELETE USING (auth.uid() = user_id);

-- Service role can insert alerts (for cron jobs)
CREATE POLICY "Service can insert alerts" ON alerts
    FOR INSERT WITH CHECK (true);

-- ============================================
-- USER SETTINGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS user_settings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    email_alerts_enabled BOOLEAN DEFAULT true,
    alert_threshold INTEGER DEFAULT 80 CHECK (alert_threshold >= 0 AND alert_threshold <= 100),
    theme TEXT DEFAULT 'light' CHECK (theme IN ('light', 'dark')),
    timezone TEXT DEFAULT 'Europe/Sofia',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id)
);

-- RLS
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own settings" ON user_settings
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own settings" ON user_settings
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own settings" ON user_settings
    FOR UPDATE USING (auth.uid() = user_id);

-- ============================================
-- PERFORMANCE HISTORY TABLE (For Forecaster)
-- ============================================
CREATE TABLE IF NOT EXISTS account_performance_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ad_account_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    date_range TEXT NOT NULL,
    
    -- Aggregated metrics
    total_spend DECIMAL(12,2) DEFAULT 0,
    total_results INTEGER DEFAULT 0,
    total_impressions BIGINT DEFAULT 0,
    total_clicks INTEGER DEFAULT 0,
    total_revenue DECIMAL(12,2) DEFAULT 0,
    
    -- Calculated averages
    avg_cost_per_result DECIMAL(10,2) DEFAULT 0,
    avg_cpm DECIMAL(10,2) DEFAULT 0,
    avg_ctr DECIMAL(5,4) DEFAULT 0,
    avg_roas DECIMAL(10,2) DEFAULT 0,
    
    -- Variance for confidence intervals
    cost_per_result_stddev DECIMAL(10,2) DEFAULT 0,
    
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(user_id, ad_account_id, objective, date_range)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_performance_history_user_id ON account_performance_history(user_id);
CREATE INDEX IF NOT EXISTS idx_performance_history_account ON account_performance_history(ad_account_id);
CREATE INDEX IF NOT EXISTS idx_performance_history_objective ON account_performance_history(objective);

-- RLS
ALTER TABLE account_performance_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own history" ON account_performance_history
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service can manage history" ON account_performance_history
    FOR ALL USING (true);

-- ============================================
-- TOP ADS CACHE TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS top_ads_cache (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ad_account_id TEXT NOT NULL,
    ad_id TEXT NOT NULL,
    ad_name TEXT NOT NULL,
    campaign_name TEXT,
    adset_name TEXT,
    
    -- Metrics
    spend DECIMAL(12,2) DEFAULT 0,
    results INTEGER DEFAULT 0,
    revenue DECIMAL(12,2) DEFAULT 0,
    roas DECIMAL(10,2) DEFAULT 0,
    cpa DECIMAL(10,2) DEFAULT 0,
    ctr DECIMAL(5,4) DEFAULT 0,
    cpm DECIMAL(10,2) DEFAULT 0,
    
    -- Quality indicators
    quality_ranking TEXT,
    engagement_rate_ranking TEXT,
    conversion_rate_ranking TEXT,
    
    date_range TEXT DEFAULT 'last_30_days',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(user_id, ad_account_id, ad_id, date_range)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_top_ads_user_id ON top_ads_cache(user_id);
CREATE INDEX IF NOT EXISTS idx_top_ads_account ON top_ads_cache(ad_account_id);
CREATE INDEX IF NOT EXISTS idx_top_ads_roas ON top_ads_cache(roas DESC);

-- RLS
ALTER TABLE top_ads_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own top ads" ON top_ads_cache
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service can manage top ads" ON top_ads_cache
    FOR ALL USING (true);

-- ============================================
-- FORECASTS TABLE (Saved Predictions)
-- ============================================
CREATE TABLE IF NOT EXISTS forecasts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ad_account_id TEXT NOT NULL,
    objective TEXT DEFAULT 'all',
    budget DECIMAL(12,2) NOT NULL,
    forecast_data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_forecasts_user_id ON forecasts(user_id);
CREATE INDEX IF NOT EXISTS idx_forecasts_account ON forecasts(ad_account_id);
CREATE INDEX IF NOT EXISTS idx_forecasts_created_at ON forecasts(created_at DESC);

-- RLS
ALTER TABLE forecasts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own forecasts" ON forecasts
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service can manage forecasts" ON forecasts
    FOR ALL USING (true);

-- ============================================
-- AUDIT LOG TABLE (Security)
-- ============================================
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    table_name TEXT,
    record_id TEXT,
    old_values JSONB,
    new_values JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for querying audit logs
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);

-- RLS: Users can only view their own audit logs
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own audit logs" ON audit_log
    FOR SELECT USING (auth.uid() = user_id);

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to relevant tables
CREATE TRIGGER update_meta_tokens_updated_at
    BEFORE UPDATE ON meta_tokens
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_ad_accounts_updated_at
    BEFORE UPDATE ON ad_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_campaigns_updated_at
    BEFORE UPDATE ON campaigns
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_settings_updated_at
    BEFORE UPDATE ON user_settings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to create default user settings on signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO user_settings (user_id)
    VALUES (NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for new user signup
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Function to clean up expired tokens
CREATE OR REPLACE FUNCTION cleanup_expired_tokens()
RETURNS void AS $$
BEGIN
    DELETE FROM meta_tokens WHERE expires_at < NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- SECURITY: Rate Limiting Table
-- ============================================
CREATE TABLE IF NOT EXISTS rate_limits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    identifier TEXT NOT NULL,  -- user_id or IP
    endpoint TEXT NOT NULL,
    request_count INTEGER DEFAULT 1,
    window_start TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(identifier, endpoint)
);

-- Index for cleanup
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

-- Function to check rate limit
CREATE OR REPLACE FUNCTION check_rate_limit(
    p_identifier TEXT,
    p_endpoint TEXT,
    p_max_requests INTEGER DEFAULT 100,
    p_window_seconds INTEGER DEFAULT 3600
)
RETURNS BOOLEAN AS $$
DECLARE
    v_count INTEGER;
    v_window_start TIMESTAMPTZ;
BEGIN
    -- Get current window
    SELECT request_count, window_start INTO v_count, v_window_start
    FROM rate_limits
    WHERE identifier = p_identifier AND endpoint = p_endpoint;
    
    -- If no record or window expired, create/reset
    IF v_window_start IS NULL OR v_window_start < NOW() - (p_window_seconds || ' seconds')::INTERVAL THEN
        INSERT INTO rate_limits (identifier, endpoint, request_count, window_start)
        VALUES (p_identifier, p_endpoint, 1, NOW())
        ON CONFLICT (identifier, endpoint) 
        DO UPDATE SET request_count = 1, window_start = NOW();
        RETURN TRUE;
    END IF;
    
    -- Check if limit exceeded
    IF v_count >= p_max_requests THEN
        RETURN FALSE;
    END IF;
    
    -- Increment counter
    UPDATE rate_limits 
    SET request_count = request_count + 1
    WHERE identifier = p_identifier AND endpoint = p_endpoint;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================
COMMENT ON TABLE meta_tokens IS 'Stores encrypted Meta API access tokens for each user';
COMMENT ON TABLE ad_accounts IS 'Connected Meta ad accounts with current spend/budget data';
COMMENT ON TABLE campaigns IS 'Campaign-level data for detailed monitoring';
COMMENT ON TABLE alerts IS 'Budget and performance alerts sent to users';
COMMENT ON TABLE user_settings IS 'User preferences for notifications and display';
COMMENT ON TABLE account_performance_history IS 'Historical metrics aggregated for forecaster';
COMMENT ON TABLE top_ads_cache IS 'Cached top performing ads data';
COMMENT ON TABLE audit_log IS 'Security audit trail of user actions';
COMMENT ON TABLE rate_limits IS 'API rate limiting protection';
