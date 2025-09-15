import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import * as https from 'https';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

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
  summary?: string;
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
    
    // Process each story to get basic info and summaries
    const stories: StoryInfo[] = [];
    
    for (const story of topStories) {
      try {
        const storyInfo = await processStoryWithSummary(story);
        stories.push(storyInfo);
        console.log(`✅ Processed: "${storyInfo.title}" (${storyInfo.score} points, ${storyInfo.comments} comments)`);
        if (storyInfo.summary) {
          console.log(`📝 Summary: ${storyInfo.summary}`);
        }
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
      if (story.summary) {
        console.log(`   💡 Key Insights: ${story.summary}`);
      }
      console.log('');
    });

    console.log('=== END SUMMARY ===\n');

    // Send email summary
    let emailSent = false;
    try {
      await sendEmailSummary(stories, currentTime);
      emailSent = true;
      console.log('📧 Email summary sent successfully to xkevinj@gmail.com');
    } catch (error) {
      console.error('❌ Failed to send email:', error);
    }

    const result = {
      statusCode: 200,
      message: 'NewsAgent completed successfully',
      timestamp: currentTime,
      source: event.source === 'aws.events' ? 'scheduled-event' : 'manual-invocation',
      data: {
        storiesProcessed: stories.length,
        stories: stories,
        emailSent: emailSent
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

async function processStoryWithSummary(story: HackerNewsItem): Promise<StoryInfo> {
  const basicInfo: StoryInfo = {
    title: story.title,
    url: story.url || 'No URL available',
    score: story.score,
    author: story.by,
    comments: story.descendants || 0,
    timestamp: new Date(story.time * 1000).toISOString()
  };

  // Try to fetch and summarize article content
  if (story.url && story.url !== 'No URL available') {
    try {
      const articleContent = await fetchArticleContent(story.url);
      if (articleContent && articleContent !== 'Unable to fetch article content') {
        const summary = await summarizeWithBedrock(story.title, articleContent);
        basicInfo.summary = summary;
      }
    } catch (error) {
      console.error(`Failed to summarize article: ${story.title}`, error);
      // Continue without summary rather than failing completely
    }
  }

  return basicInfo;
}

async function fetchArticleContent(url: string): Promise<string> {
  try {
    console.log(`📖 Fetching article content from: ${url}`);
    const content = await httpGet(url);
    
    // Simple text extraction - remove HTML tags and extract meaningful content
    const textContent = content
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove scripts
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '') // Remove styles
      .replace(/<[^>]*>/g, ' ') // Remove HTML tags
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();

    // Take first 4000 characters to avoid token limits
    const truncatedContent = textContent.length > 4000 ? textContent.substring(0, 4000) + '...' : textContent;
    
    return truncatedContent;
  } catch (error) {
    console.error(`❌ Failed to fetch article content from ${url}:`, error);
    return 'Unable to fetch article content';
  }
}

async function summarizeWithBedrock(title: string, content: string): Promise<string> {
  try {
    console.log(`🤖 Generating summary for: ${title}`);
    
    const bedrockClient = new BedrockRuntimeClient({ 
      region: process.env.AWS_REGION || 'us-west-2' 
    });

    const prompt = `Human: Please analyze this article and provide exactly 2 parts:

1. **Summary**: A concise overview of what the article is about and its main points
2. **Key Insight**: The single most interesting, surprising, or valuable takeaway that makes this article worth reading

Keep both parts brief and focused. Do not repeat the article title in your response.

Article content:
${content}

Assistant:`;

    const body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1000,
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    };

    const command = new InvokeModelCommand({
      modelId: "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
      contentType: "application/json",
      body: JSON.stringify(body)
    });

    const response = await bedrockClient.send(command);
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    
    return responseBody.content[0].text.trim();
  } catch (error) {
    console.error(`❌ Failed to summarize with Bedrock:`, error);
    return 'Summary unavailable';
  }
}

async function sendEmailSummary(stories: StoryInfo[], timestamp: string): Promise<void> {
  const sesClient = new SESClient({ 
    region: process.env.AWS_REGION || 'us-west-2' 
  });

  // Create HTML email content
  const htmlContent = generateEmailHTML(stories, timestamp);
  const textContent = generateEmailText(stories, timestamp);

  const params = {
    Destination: {
      ToAddresses: ['xkevinj@gmail.com']
    },
    Message: {
      Body: {
        Html: {
          Charset: 'UTF-8',
          Data: htmlContent
        },
        Text: {
          Charset: 'UTF-8',
          Data: textContent
        }
      },
      Subject: {
        Charset: 'UTF-8',
        Data: `📰 Hacker News Summary - ${new Date(timestamp).toLocaleDateString()}`
      }
    },
    Source: process.env.SES_FROM_EMAIL || 'newsagent@example.com' // You'll need to verify this email in SES
  };

  const command = new SendEmailCommand(params);
  await sesClient.send(command);
}

function generateEmailHTML(stories: StoryInfo[], timestamp: string): string {
  const date = new Date(timestamp).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  let storiesHTML = '';
  stories.forEach((story, index) => {
    storiesHTML += `
      <div style="margin-bottom: 25px; padding: 15px; background-color: #f9f9f9;">
        <h3 style="margin: 0 0 10px 0; color: #333;">
          ${index + 1}. <a href="${story.url}" style="color: #ff6600; text-decoration: none;">${story.title}</a>
        </h3>
        <p style="margin: 5px 0; color: #666; font-size: 14px;">
          👤 <strong>Author:</strong> ${story.author} | 
          ⭐ <strong>Score:</strong> ${story.score} points | 
          💬 <strong>Comments:</strong> ${story.comments}
        </p>
        <p style="margin: 5px 0; color: #888; font-size: 12px;">
          🕐 Posted: ${new Date(story.timestamp).toLocaleString()}
        </p>`;
    
    if (story.summary) {
      // Convert markdown to HTML for better rendering
      const htmlSummary = story.summary
        .replace(/# (.*)/g, '<h3 style="color: #ff6600; margin: 15px 0 10px 0; font-size: 16px;">$1</h3>')
        .replace(/## (.*)/g, '<h4 style="color: #333; margin: 12px 0 8px 0; font-size: 15px; font-weight: bold;">$1</h4>')
        .replace(/### (.*)/g, '<h5 style="color: #555; margin: 10px 0 6px 0; font-size: 14px; font-weight: bold;">$1</h5>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/^\d+\. (.*)/gm, '<div style="margin: 8px 0; padding-left: 15px;"><strong>• $1</strong></div>')
        .replace(/\n\n/g, '</p><p style="margin: 8px 0; line-height: 1.6;">')
        .replace(/\n/g, '<br>');
      
      storiesHTML += `
        <div style="margin-top: 15px; padding: 20px; background-color: #fff; border-radius: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <div style="color: #444; font-size: 14px; line-height: 1.6;">
            <p style="margin: 8px 0; line-height: 1.6;">${htmlSummary}</p>
          </div>
        </div>`;
    }
    
    storiesHTML += `
      </div>
    `;
  });

  return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Hacker News Summary</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px; padding: 20px; background-color: #ff6600; color: white; border-radius: 8px;">
            <h1 style="margin: 0;">📰 Hacker News Summary</h1>
            <p style="margin: 10px 0 0 0;">Generated by NewsAgent with AI Summaries</p>
            <p style="margin: 5px 0 0 0; font-size: 14px;">${date}</p>
        </div>
        
        <div style="margin-bottom: 20px;">
            <h2 style="color: #ff6600;">🔥 Top ${stories.length} Stories</h2>
            ${storiesHTML}
        </div>
        
        <div style="text-align: center; margin-top: 30px; padding: 15px; background-color: #f0f0f0; border-radius: 6px; font-size: 12px; color: #666;">
            <p>This summary was automatically generated by your NewsAgent Lambda function.</p>
            <p>🤖 Powered by AWS Lambda, Bedrock & Hacker News API</p>
        </div>
    </body>
    </html>
  `;
}

function generateEmailText(stories: StoryInfo[], timestamp: string): string {
  const date = new Date(timestamp).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  let storiesText = '';
  stories.forEach((story, index) => {
    storiesText += `
${index + 1}. ${story.title}
   Author: ${story.author} | Score: ${story.score} points | Comments: ${story.comments}
   URL: ${story.url}
   Posted: ${new Date(story.timestamp).toLocaleString()}`;
    
    if (story.summary) {
      // Clean up markdown for plain text email
      const cleanSummary = story.summary
        .replace(/# (.*)/g, '\n📋 $1\n' + '='.repeat(50))
        .replace(/## (.*)/g, '\n🔍 $1\n' + '-'.repeat(30))
        .replace(/### (.*)/g, '\n• $1')
        .replace(/\*\*(.*?)\*\*/g, '$1')
        .replace(/\*(.*?)\*/g, '$1')
        .replace(/^\d+\. /gm, '   → ');
      
      storiesText += `
   
${cleanSummary}`;
    }
    
    storiesText += `

`;
  });

  return `
HACKER NEWS SUMMARY
Generated by NewsAgent with AI Summaries
${date}

Top ${stories.length} Stories:
${storiesText}
---
This summary was automatically generated by your NewsAgent Lambda function.
Powered by AWS Lambda, Bedrock & Hacker News API
  `;
}
