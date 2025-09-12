import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import * as https from 'https';

interface HackerNewsItem {
  id: number;
  title: string;
  url?: string;
  score: number;
  by: string;
  time: number;
  descendants?: number;
}

interface StoryInfo {
  title: string;
  url: string;
  score: number;
  author: string;
  comments: number;
  timestamp: string;
}

export const handler = async (
  event: APIGatewayProxyEvent | any,
  context: Context
): Promise<APIGatewayProxyResult | any> => {
  console.log('🤖 NewsAgent Lambda function started!');
  console.log('Event source:', event.source || 'direct-invocation');

  const currentTime = new Date().toISOString();
  
  try {
    // Fetch top stories from Hacker News
    console.log('📰 Fetching top stories from Hacker News...');
    const topStories = await getTopHackerNewsStories(5); // Get top 5 stories
    
    console.log(`📊 Found ${topStories.length} top stories`);
    
    // Process each story to get basic info
    const stories: StoryInfo[] = [];
    
    for (const story of topStories) {
      try {
        const storyInfo = processStory(story);
        stories.push(storyInfo);
        console.log(`✅ Processed: "${storyInfo.title}" (${storyInfo.score} points, ${storyInfo.comments} comments)`);
      } catch (error) {
        console.log(`❌ Failed to process story: ${story.title}`, error);
      }
    }

    // Log comprehensive summary
    console.log('\n=== 📈 HACKER NEWS TOP STORIES ===');
    console.log(`📅 Generated at: ${currentTime}`);
    console.log(`📊 Total stories processed: ${stories.length}`);
    console.log('');

    stories.forEach((story, index) => {
      console.log(`${index + 1}. 📰 ${story.title}`);
      console.log(`   👤 Author: ${story.author} | ⭐ Score: ${story.score} points | 💬 ${story.comments} comments`);
      console.log(`   🔗 URL: ${story.url}`);
      console.log('');
    });

    console.log('=== END SUMMARY ===\n');

    const result = {
      statusCode: 200,
      message: 'NewsAgent completed successfully',
      timestamp: currentTime,
      source: event.source === 'aws.events' ? 'scheduled-event' : 'manual-invocation',
      data: {
        storiesProcessed: stories.length,
        stories: stories
      }
    };

    // If this is triggered by EventBridge, return simple response
    if (event.source === 'aws.events') {
      console.log('🔄 Triggered by scheduled cron job');
      return result;
    }

    // If this is an API Gateway request, return proper API Gateway response
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: JSON.stringify(result),
    };

  } catch (error) {
    console.error('💥 NewsAgent encountered an error:', error);
    
    const errorResult = {
      statusCode: 500,
      message: 'NewsAgent failed',
      timestamp: currentTime,
      error: error instanceof Error ? error.message : 'Unknown error'
    };

    if (event.source === 'aws.events') {
      return errorResult;
    }

    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify(errorResult),
    };
  }
};

async function httpGet(url: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsAgent/1.0)',
        ...headers
      },
      timeout: 10000
    };

    const req = https.request(options, (res: any) => {
      let data = '';
      
      res.on('data', (chunk: any) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
        }
      });
    });

    req.on('error', (error: any) => {
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

async function getTopHackerNewsStories(limit: number = 5): Promise<HackerNewsItem[]> {
  try {
    // Get top story IDs
    const topStoriesData = await httpGet('https://hacker-news.firebaseio.com/v0/topstories.json');
    const topStoryIds = JSON.parse(topStoriesData).slice(0, limit);

    // Fetch details for each story
    const stories: HackerNewsItem[] = [];
    
    for (const storyId of topStoryIds) {
      try {
        const storyData = await httpGet(`https://hacker-news.firebaseio.com/v0/item/${storyId}.json`);
        const story = JSON.parse(storyData);
        
        if (story && story.type === 'story' && story.url) {
          stories.push(story);
        }
      } catch (error) {
        console.log(`Failed to fetch story ${storyId}:`, error);
      }
    }

    return stories;
  } catch (error) {
    console.error('Failed to fetch Hacker News stories:', error);
    throw error;
  }
}

function processStory(story: HackerNewsItem): StoryInfo {
  return {
    title: story.title,
    url: story.url || 'No URL available',
    score: story.score,
    author: story.by,
    comments: story.descendants || 0,
    timestamp: new Date(story.time * 1000).toISOString()
  };
}

