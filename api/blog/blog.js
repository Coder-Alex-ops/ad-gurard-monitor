// Notion Single Post API
// Fetches a single blog post with full content from Notion

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
    
    const { slug } = req.query;
    
    if (!slug) {
        return res.status(400).json({ error: 'Slug is required' });
    }
    
    const NOTION_API_KEY = process.env.NOTION_API_KEY;
    const DATABASE_ID = process.env.NOTION_BLOG_DATABASE_ID;
    
    if (!NOTION_API_KEY || !DATABASE_ID) {
        return res.status(500).json({ error: 'Notion configuration missing' });
    }
    
    try {
        // First, find the page by slug
        const searchResponse = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${NOTION_API_KEY}`,
                'Notion-Version': '2022-06-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                filter: {
                    and: [
                        {
                            property: 'Slug',
                            rich_text: {
                                equals: slug
                            }
                        },
                        {
                            property: 'Published',
                            checkbox: {
                                equals: true
                            }
                        }
                    ]
                }
            })
        });
        
        if (!searchResponse.ok) {
            const error = await searchResponse.json();
            console.error('Notion API error:', error);
            return res.status(500).json({ error: 'Failed to fetch from Notion' });
        }
        
        const searchData = await searchResponse.json();
        
        if (searchData.results.length === 0) {
            return res.status(404).json({ error: 'Post not found' });
        }
        
        const page = searchData.results[0];
        const pageId = page.id;
        
        // Fetch page blocks (content)
        const blocksResponse = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${NOTION_API_KEY}`,
                'Notion-Version': '2022-06-28'
            }
        });
        
        if (!blocksResponse.ok) {
            const error = await blocksResponse.json();
            console.error('Notion blocks API error:', error);
            return res.status(500).json({ error: 'Failed to fetch page content' });
        }
        
        const blocksData = await blocksResponse.json();
        
        // Convert blocks to HTML
        const contentHtml = blocksToHtml(blocksData.results);
        
        // Build post object
        const properties = page.properties;
        const post = {
            id: page.id,
            title: properties.Title?.title?.[0]?.plain_text || 'Untitled',
            slug: properties.Slug?.rich_text?.[0]?.plain_text || page.id,
            excerpt: properties.Excerpt?.rich_text?.[0]?.plain_text || '',
            date: properties.Date?.date?.start || page.created_time.split('T')[0],
            cover: page.cover?.external?.url || page.cover?.file?.url || null,
            content: contentHtml
        };
        
        return res.status(200).json({ post });
        
    } catch (error) {
        console.error('Error fetching blog post:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
}

// Convert Notion blocks to HTML
function blocksToHtml(blocks) {
    return blocks.map(block => {
        const type = block.type;
        
        switch (type) {
            case 'paragraph':
                const pText = richTextToHtml(block.paragraph.rich_text);
                return pText ? `<p>${pText}</p>` : '<br>';
                
            case 'heading_1':
                return `<h1>${richTextToHtml(block.heading_1.rich_text)}</h1>`;
                
            case 'heading_2':
                return `<h2>${richTextToHtml(block.heading_2.rich_text)}</h2>`;
                
            case 'heading_3':
                return `<h3>${richTextToHtml(block.heading_3.rich_text)}</h3>`;
                
            case 'bulleted_list_item':
                return `<li>${richTextToHtml(block.bulleted_list_item.rich_text)}</li>`;
                
            case 'numbered_list_item':
                return `<li>${richTextToHtml(block.numbered_list_item.rich_text)}</li>`;
                
            case 'quote':
                return `<blockquote>${richTextToHtml(block.quote.rich_text)}</blockquote>`;
                
            case 'code':
                const code = block.code.rich_text.map(t => t.plain_text).join('');
                const lang = block.code.language || '';
                return `<pre><code class="language-${lang}">${escapeHtml(code)}</code></pre>`;
                
            case 'divider':
                return '<hr>';
                
            case 'image':
                const imageUrl = block.image.external?.url || block.image.file?.url || '';
                const caption = block.image.caption?.map(t => t.plain_text).join('') || '';
                return `<figure><img src="${imageUrl}" alt="${caption}" loading="lazy"><figcaption>${caption}</figcaption></figure>`;
                
            case 'callout':
                const emoji = block.callout.icon?.emoji || '💡';
                return `<div class="callout"><span class="callout-icon">${emoji}</span><div>${richTextToHtml(block.callout.rich_text)}</div></div>`;
                
            default:
                return '';
        }
    }).join('\n');
}

// Convert Notion rich text to HTML
function richTextToHtml(richTextArray) {
    if (!richTextArray || richTextArray.length === 0) return '';
    
    return richTextArray.map(text => {
        let content = escapeHtml(text.plain_text);
        
        // Apply annotations
        if (text.annotations.bold) content = `<strong>${content}</strong>`;
        if (text.annotations.italic) content = `<em>${content}</em>`;
        if (text.annotations.strikethrough) content = `<del>${content}</del>`;
        if (text.annotations.underline) content = `<u>${content}</u>`;
        if (text.annotations.code) content = `<code>${content}</code>`;
        
        // Apply link
        if (text.href) {
            content = `<a href="${text.href}" target="_blank" rel="noopener">${content}</a>`;
        }
        
        return content;
    }).join('');
}

// Escape HTML special characters
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}
