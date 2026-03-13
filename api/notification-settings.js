import { createClient } from 'redis';

export default async function handler(req, res) {
    if (req.method === 'GET') {
        return getSettings(req, res);
    } else if (req.method === 'POST') {
        return saveSettings(req, res);
    } else {
        return res.status(405).json({ error: 'Method not allowed' });
    }
}

async function getSettings(req, res) {
    const sessionId = getSessionFromCookie(req);
    if (!sessionId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const redis = createClient({ url: process.env.ad_monitor_kv_REDIS_URL });
    
    try {
        await redis.connect();
        const sessionData = await redis.get(`session:${sessionId}`);
        if (!sessionData) {
            await redis.disconnect();
            return res.status(401).json({ error: 'Session expired' });
        }
        
        const session = JSON.parse(sessionData);
        const settingsData = await redis.get(`notifications:${session.userId}`);
        await redis.disconnect();
        
        return res.status(200).json({ 
            success: true, 
            settings: settingsData ? JSON.parse(settingsData) : { email: null, accounts: [], budgets: {} }
        });
    } catch (error) {
        console.error('Get settings error:', error);
        return res.status(500).json({ error: 'Failed to get settings' });
    }
}

async function saveSettings(req, res) {
    const sessionId = getSessionFromCookie(req);
    if (!sessionId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const { email, accounts, budgets } = req.body;
    const redis = createClient({ url: process.env.ad_monitor_kv_REDIS_URL });
    
    try {
        await redis.connect();
        const sessionData = await redis.get(`session:${sessionId}`);
        if (!sessionData) {
            await redis.disconnect();
            return res.status(401).json({ error: 'Session expired' });
        }
        
        const session = JSON.parse(sessionData);
        
        const settings = {
            email: email || null,
            accounts: accounts || [],
            budgets: budgets || {},
            accessToken: session.accessToken,
            tokenExpiresAt: session.expiresAt,
            updatedAt: Date.now()
        };
        
        await redis.set(`notifications:${session.userId}`, JSON.stringify(settings));
        
        if (email) {
            await redis.sAdd('notification_users', session.userId);
        } else {
            await redis.sRem('notification_users', session.userId);
        }
        
        await redis.disconnect();
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error('Save settings error:', error);
        return res.status(500).json({ error: 'Failed to save settings' });
    }
}

function getSessionFromCookie(req) {
    const cookies = req.headers.cookie || '';
    const match = cookies.match(/session=([^;]+)/);
    return match ? match[1] : null;
}
