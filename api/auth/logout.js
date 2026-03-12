import { createClient } from 'redis';

export default async function handler(req, res) {
    // Get session from cookie
    const cookies = parseCookies(req.headers.cookie || '');
    const sessionId = cookies.session;

    if (sessionId) {
        try {
            const redis = createClient({
                url: process.env.ad_monitor_kv_REDIS_URL
            });

            await redis.connect();
            await redis.del(`session:${sessionId}`);
            await redis.disconnect();

        } catch (error) {
            console.error('Logout error:', error);
        }
    }

    // Clear cookie
    res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return res.redirect('/');
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
