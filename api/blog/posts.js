// Notion Blog Posts API
// Fetches published blog posts from Notion database

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    
    const NOTION_API_KEY = process.env.NOTION_API_KEY;
    const DATABASE_ID = process.env.NOTION_BLOG_DATABASE_ID;
    
    if (!NOTION_API_KEY || !DATABASE_ID) {
        return res.status(500).json({ error: 'Notion configuration missing' });
    }
    
    try {
        // Query Notion database for published posts
        const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${NOTION_API_KEY}`,
                'Notion-Version': '2022-06-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filter: {
                    property: 'Published',
                    checkbox: {
                        equals: true
                    }
                },
                sorts: [
                    {
                        property: 'Date',
                        direction: 'descending'
                    }
                ]
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            console.error('Notion API error:', error);
            return res.status(500).json({ error: 'Failed to fetch from Notion' });
        }
        
        const data = await response.json();
        
        // Transform Notion data to simple format
        const posts = data.results.map(page => {
            const properties = page.properties;
            
            return {
                id: page.id,
                title: properties.Title?.title?.[0]?.plain_text || 'Untitled',
                slug: properties.Slug?.rich_text?.[0]?.plain_text || page.id,
                excerpt: properties.Excerpt?.rich_text?.[0]?.plain_text || '',
                date: properties.Date?.date?.start || page.created_time.split('T')[0],
                cover: page.cover?.external?.url || page.cover?.file?.url || null
            };
        });
        
        return res.status(200).json({ posts });
        
    } catch (error) {
        console.error('Error fetching blog posts:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
