import { createClient } from 'redis';

export default async function handler(req, res) {
    // Get session from cookie
    const cookies = parseCookies(req.headers.cookie || '');
    const sessionId = cookies.session;

    if (!sessionId) {
        return res.status(401).json({ error: 'Not authenticated', authenticated: false });
    }

    try {
        const redis = createClient({
            url: process.env.ad_monitor_kv_REDIS_URL
        });

        await redis.connect();

        const sessionData = await redis.get(`session:${sessionId}`);

        await redis.disconnect();

        if (!sessionData) {
            return res.status(401).json({ error: 'Session expired', authenticated: false });
        }

        const session = JSON.parse(sessionData);

        // Check if token is expired
        if (session.expiresAt && session.expiresAt < Date.now()) {
            return res.status(401).json({ error: 'Token expired', authenticated: false });
        }

        return res.status(200).json({
            authenticated: true,
            user: {
                id: session.userId,
                name: session.userName,
                email: session.userEmail
            },
            accessToken: session.accessToken,
            expiresAt: session.expiresAt
        });

    } catch (error) {
        console.error('Session check error:', error);
        return res.status(500).json({ error: 'Server error', authenticated: false });
    }
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;

    cookieHeader.split(';').forEach(cookie => {
        const [name, ...rest] = cookie.split('=');
        if (name && rest.length > 0) {
            cookies[name.trim()] = rest.join('=').trim();
        }
    });

    return cookies;
}
