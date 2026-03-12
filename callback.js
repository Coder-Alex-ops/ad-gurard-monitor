import { createClient } from 'redis';

export default async function handler(req, res) {
    const { code, error, error_description } = req.query;

    // Handle OAuth errors
    if (error) {
        console.error('OAuth error:', error, error_description);
        return res.redirect(`/dashboard.html?error=${encodeURIComponent(error_description || error)}`);
    }

    // Validate code
    if (!code) {
        return res.redirect('/dashboard.html?error=No authorization code received');
    }

    try {
        // Exchange code for access token
        const tokenUrl = 'https://graph.facebook.com/v19.0/oauth/access_token';
        const params = new URLSearchParams({
            client_id: process.env.META_APP_ID,
            client_secret: process.env.META_APP_SECRET,
            redirect_uri: 'https://ad-gurard-monitor.vercel.app/api/auth/callback',
            code: code
        });

        const tokenResponse = await fetch(`${tokenUrl}?${params}`);
        const tokenData = await tokenResponse.json();

        if (tokenData.error) {
            console.error('Token exchange error:', tokenData.error);
            return res.redirect(`/dashboard.html?error=${encodeURIComponent(tokenData.error.message)}`);
        }

        const { access_token, expires_in } = tokenData;

        // Get long-lived token (60 days)
        const longLivedParams = new URLSearchParams({
            grant_type: 'fb_exchange_token',
            client_id: process.env.META_APP_ID,
            client_secret: process.env.META_APP_SECRET,
            fb_exchange_token: access_token
        });

        const longLivedResponse = await fetch(`${tokenUrl}?${longLivedParams}`);
        const longLivedData = await longLivedResponse.json();

        const finalToken = longLivedData.access_token || access_token;
        const finalExpiry = longLivedData.expires_in || expires_in;

        // Get user info
        const userResponse = await fetch(
            `https://graph.facebook.com/v19.0/me?fields=id,name,email&access_token=${finalToken}`
        );
        const userData = await userResponse.json();

        if (userData.error) {
            console.error('User info error:', userData.error);
            return res.redirect(`/dashboard.html?error=${encodeURIComponent(userData.error.message)}`);
        }

        // Store in Redis
        const redis = createClient({
            url: process.env.ad_monitor_kv_REDIS_URL
        });

        await redis.connect();

        const sessionId = generateSessionId();
        const sessionData = {
            userId: userData.id,
            userName: userData.name,
            userEmail: userData.email || null,
            accessToken: finalToken,
            expiresAt: Date.now() + (finalExpiry * 1000),
            createdAt: Date.now()
        };

        // Store session (expires in 60 days)
        await redis.set(`session:${sessionId}`, JSON.stringify(sessionData), {
            EX: finalExpiry || 5184000 // 60 days default
        });

        await redis.disconnect();

        // Set session cookie and redirect
        res.setHeader('Set-Cookie', `session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${finalExpiry || 5184000}`);
        return res.redirect('/dashboard.html');

    } catch (error) {
        console.error('OAuth callback error:', error);
        return res.redirect(`/dashboard.html?error=${encodeURIComponent('Authentication failed. Please try again.')}`);
    }
}

function generateSessionId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}
