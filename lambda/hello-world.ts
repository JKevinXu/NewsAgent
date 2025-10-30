import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import * as https from 'https';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient, SynthesizeSpeechCommand } from '@aws-sdk/client-polly';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

interface HackerNewsItem {
  id: number;
  title: string;
  url?: string;
  score: number;
  by: string;
  time: number;
  descendants?: number;
}

interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  description: string;
  html_url: string;
  stargazers_count: number;
  language: string;
  created_at: string;
  updated_at: string;
  owner: {
    login: string;
    avatar_url: string;
  };
}

interface StoryInfo {
  title: string;
  url: string;
  score: number;
  author: string;
  comments: number;
  timestamp: string;
  source: 'hacker-news' | 'github-trending';
  summary?: string;
  audioUrl?: string;
}

interface NewsletterData {
  stories: StoryInfo[];
  combinedAudioUrl?: string;
}

interface DailyRecommendation {
  id: string; // unique identifier for each story (partition key)
  date: string; // YYYY-MM-DD format 
  source: 'hacker-news' | 'github-trending';
  title: string;
  url: string;
  score: number;
  author: string;
  comments: number;
  timestamp: string; // ISO string
  summary?: string;
  audioUrl?: string;
  ttl: number; // Unix timestamp for automatic deletion after 365 days
}

interface DailyDigest {
  id: string; // 'digest-YYYY-MM-DD' (partition key)
  date: string; // YYYY-MM-DD format
  source: 'daily-digest';
  totalStories: number;
  timestamp: string; // ISO string
  combinedAudioUrl?: string;
  emailSent: boolean;
  ttl: number; // Unix timestamp for automatic deletion after 365 days
}

export const handler = async (
  event: APIGatewayProxyEvent | any,
  context: Context
): Promise<APIGatewayProxyResult | any> => {
  console.log('🤖 NewsAgent Lambda function started!');
  console.log('Event source:', event.source || 'direct-invocation');

  const currentTime = new Date().toISOString();
  
  try {
    // Fetch content from multiple sources
    console.log('📰 Fetching top stories from Hacker News...');
    const topStories = await getTopHackerNewsStories(5); // Get top 5 stories
    
    console.log('⭐ Fetching trending GitHub repositories...');
    const trendingRepos = await getTopGitHubTrending(5); // Get top 5 repos
    
    console.log(`📊 Found ${topStories.length} Hacker News stories and ${trendingRepos.length} GitHub repositories`);
    
    // Process each story to get basic info and summaries
    const stories: StoryInfo[] = [];
    
    // Process Hacker News stories
    for (const story of topStories) {
      try {
        const storyInfo = await processStoryWithSummary(story);
        stories.push(storyInfo);
        console.log(`✅ Processed HN: "${storyInfo.title}" (${storyInfo.score} points, ${storyInfo.comments} comments)`);
        if (storyInfo.summary) {
          console.log(`📝 Summary: ${storyInfo.summary}`);
        }
      } catch (error) {
        console.log(`❌ Failed to process HN story: ${story.title}`, error);
      }
    }
    
    // Process GitHub trending repositories
    for (const repo of trendingRepos) {
      try {
        const repoInfo = await processGitHubRepository(repo);
        stories.push(repoInfo);
        console.log(`✅ Processed GitHub: "${repoInfo.title}" (${repoInfo.score} stars, ${repoInfo.comments} issues)`);
        if (repoInfo.summary) {
          console.log(`📝 Summary: ${repoInfo.summary}`);
        }
      } catch (error) {
        console.log(`❌ Failed to process GitHub repo: ${repo.full_name}`, error);
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

    // Filter stories with summaries for combined audio
    const storiesWithSummaries = stories.filter(story => story.summary && story.summary !== 'Summary unavailable');
    
    // Generate combined audio for all summaries
    let combinedAudioUrl: string | undefined;
    if (storiesWithSummaries.length > 0) {
      combinedAudioUrl = await generateCombinedAudio(storiesWithSummaries, currentTime);
    }

    // Prepare newsletter data
    const newsletterData: NewsletterData = {
      stories: storiesWithSummaries,
      combinedAudioUrl
    };

    // Save recommendations to database
    try {
      await saveDailyRecommendations(stories, currentTime, combinedAudioUrl);
      console.log('💾 Daily recommendations saved to database successfully');
    } catch (error) {
      console.error('❌ Failed to save recommendations to database:', error);
    }

    // Send email summary
    let emailSent = false;
    try {
      await sendEmailSummary(newsletterData, currentTime);
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
        emailSent: emailSent,
        combinedAudioUrl: combinedAudioUrl
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

async function getTopGitHubTrending(limit: number = 2): Promise<GitHubRepository[]> {
  try {
    console.log('⭐ Fetching GitHub trending repositories...');
    
    // Get repositories created in the last week, sorted by stars
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const dateString = oneWeekAgo.toISOString().split('T')[0];
    
    const apiUrl = `https://api.github.com/search/repositories?q=created:>${dateString}&sort=stars&order=desc&per_page=${limit}`;
    
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'Mozilla/5.0 (compatible; NewsAgent/1.0)'
    };

    const response = await httpGet(apiUrl, headers);
    const data = JSON.parse(response);
    
    if (data.items && data.items.length > 0) {
      console.log(`⭐ Found ${data.items.length} trending GitHub repositories`);
      return data.items.slice(0, limit);
    } else {
      console.log('⭐ No trending repositories found, using fallback');
      return [];
    }
  } catch (error) {
    console.error('Failed to fetch GitHub trending repositories:', error);
    return [];
  }
}


async function processStoryWithSummary(story: HackerNewsItem): Promise<StoryInfo> {
  const basicInfo: StoryInfo = {
    title: story.title,
    url: story.url || 'No URL available',
    score: story.score,
    author: story.by,
    comments: story.descendants || 0,
    timestamp: new Date(story.time * 1000).toISOString(),
    source: 'hacker-news'
  };

  // Try to fetch and summarize article content
  if (story.url && story.url !== 'No URL available') {
    try {
      const articleContent = await fetchArticleContent(story.url);
      if (articleContent && articleContent !== 'Unable to fetch article content') {
        const summary = await summarizeWithBedrock(story.title, articleContent);
        basicInfo.summary = summary;
        
        // Generate audio for the summary
        if (summary && summary !== 'Summary unavailable') {
          const audioUrl = await generateAudio(story.title, summary);
          basicInfo.audioUrl = audioUrl;
        }
      }
    } catch (error) {
      console.error(`Failed to summarize article: ${story.title}`, error);
      // Continue without summary rather than failing completely
    }
  }

  return basicInfo;
}


async function processGitHubRepository(repo: GitHubRepository): Promise<StoryInfo> {
  const basicInfo: StoryInfo = {
    title: repo.full_name,
    url: repo.html_url,
    score: repo.stargazers_count,
    author: repo.owner.login,
    comments: 0, // GitHub API doesn't easily provide issue count in search results
    timestamp: repo.created_at,
    source: 'github-trending'
  };

  // Create a summary from the GitHub repository data
  const repoSummary = `## Summary\n\n${repo.full_name} is a trending GitHub repository${repo.language ? ` written in ${repo.language}` : ''}. ${repo.description || 'No description provided.'}\n\n## Key Insight\n\nThis repository has gained ${repo.stargazers_count} stars, indicating strong developer interest and potential utility. The project represents current trends in the open-source development community.`;
  
  basicInfo.summary = repoSummary;

  // Generate audio for the GitHub repository summary
  if (basicInfo.summary) {
    const audioUrl = await generateAudio(basicInfo.title, basicInfo.summary);
    basicInfo.audioUrl = audioUrl;
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

async function generateAudio(title: string, summary: string): Promise<string | undefined> {
  try {
    console.log(`🎵 Generating audio for: ${title}`);
    
    const pollyClient = new PollyClient({ 
      region: process.env.AWS_REGION || 'us-west-2' 
    });
    
    const s3Client = new S3Client({ 
      region: process.env.AWS_REGION || 'us-west-2' 
    });

    // Clean text for speech synthesis
    const speechText = summary
      .replace(/^#+\s*/gm, '') // Remove markdown headers
      .replace(/\*\*(.*?)\*\*/g, '$1') // Remove bold formatting
      .replace(/\*(.*?)\*/g, '$1') // Remove italic formatting
      .replace(/\n+/g, ' ') // Replace line breaks with spaces
      .trim();

    // Generate speech with Polly
    const synthesizeCommand = new SynthesizeSpeechCommand({
      Text: speechText,
      OutputFormat: 'mp3',
      VoiceId: 'Joanna', // Natural-sounding neural voice
      Engine: 'neural'
    });

    const pollyResponse = await pollyClient.send(synthesizeCommand);
    
    if (!pollyResponse.AudioStream) {
      throw new Error('No audio stream received from Polly');
    }

    // Convert audio stream to buffer
    const audioBuffer = await streamToBuffer(pollyResponse.AudioStream);
    
    // Generate unique filename
    const timestamp = new Date().toISOString().slice(0, 10);
    const titleSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    const filename = `audio/${timestamp}/${titleSlug}.mp3`;
    
    // Upload to S3
    const bucketName = process.env.AUDIO_BUCKET_NAME;
    if (!bucketName) {
      throw new Error('AUDIO_BUCKET_NAME environment variable not set');
    }

    const uploadCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: filename,
      Body: audioBuffer,
      ContentType: 'audio/mpeg'
    });

    await s3Client.send(uploadCommand);
    
    const audioUrl = `https://${bucketName}.s3.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com/${filename}`;
    console.log(`🎵 Audio generated: ${audioUrl}`);
    
    return audioUrl;
  } catch (error) {
    console.error(`❌ Failed to generate audio:`, error);
    return undefined;
  }
}

async function generateCombinedAudio(stories: StoryInfo[], timestamp: string): Promise<string | undefined> {
  try {
    console.log(`🎵 Generating combined audio for ${stories.length} stories`);
    
    const pollyClient = new PollyClient({ 
      region: process.env.AWS_REGION || 'us-west-2' 
    });
    
    const s3Client = new S3Client({ 
      region: process.env.AWS_REGION || 'us-west-2' 
    });

    const audioBuffers: Buffer[] = [];
    
    // Generate intro
    console.log('🎵 Generating intro audio...');
    const introText = "Welcome to your Hacker News daily digest. Here are today's top stories with AI-generated summaries.";
    const introBuffer = await generateSingleAudioBuffer(pollyClient, introText);
    if (introBuffer) audioBuffers.push(introBuffer);
    
    // Generate audio for each story individually
    for (let index = 0; index < stories.length; index++) {
      const story = stories[index];
      if (story.summary) {
        console.log(`🎵 Generating audio for story ${index + 1}: ${story.title}`);
        
        // Create title introduction
        const titleText = `Story ${index + 1}: ${story.title}.`;
        const titleBuffer = await generateSingleAudioBuffer(pollyClient, titleText);
        if (titleBuffer) audioBuffers.push(titleBuffer);
        
        // Clean the full summary for audio (keep complete summary)
        const cleanSummary = story.summary
          .replace(/^#+\s*/gm, '') // Remove markdown headers
          .replace(/\*\*(.*?)\*\*/g, '$1') // Remove bold formatting
          .replace(/\*(.*?)\*/g, '$1') // Remove italic formatting
          .replace(/\n+/g, ' ') // Replace line breaks with spaces
          .trim();
        
        // Split long summaries into chunks if needed (Polly has 3000 char limit)
        const summaryChunks = splitTextIntoChunks(cleanSummary, 2500);
        
        // Generate audio for each chunk of the summary
        for (const chunk of summaryChunks) {
          const chunkBuffer = await generateSingleAudioBuffer(pollyClient, chunk);
          if (chunkBuffer) audioBuffers.push(chunkBuffer);
        }
        
        // Add a small pause between stories
        if (index < stories.length - 1) {
          const pauseBuffer = await generateSingleAudioBuffer(pollyClient, "Next story.");
          if (pauseBuffer) audioBuffers.push(pauseBuffer);
        }
      }
    }
    
    // Generate outro
    console.log('🎵 Generating outro audio...');
    const outroText = "That concludes today's Hacker News digest. Thank you for listening.";
    const outroBuffer = await generateSingleAudioBuffer(pollyClient, outroText);
    if (outroBuffer) audioBuffers.push(outroBuffer);
    
    if (audioBuffers.length === 0) {
      throw new Error('No audio buffers were generated');
    }
    
    // Concatenate all audio buffers
    console.log(`🎵 Concatenating ${audioBuffers.length} audio segments...`);
    const combinedBuffer = Buffer.concat(audioBuffers as Uint8Array[]);
    
    // Generate unique filename for combined audio
    const dateStamp = new Date().toISOString().slice(0, 10);
    const filename = `audio/${dateStamp}/daily-digest-${Date.now()}.mp3`;
    
    // Upload to S3
    const bucketName = process.env.AUDIO_BUCKET_NAME;
    if (!bucketName) {
      throw new Error('AUDIO_BUCKET_NAME environment variable not set');
    }

    const uploadCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: filename,
      Body: combinedBuffer,
      ContentType: 'audio/mpeg'
    });

    await s3Client.send(uploadCommand);
    
    const audioUrl = `https://${bucketName}.s3.${process.env.AWS_REGION || 'us-west-2'}.amazonaws.com/${filename}`;
    console.log(`🎵 Combined audio generated: ${audioUrl}`);
    
    return audioUrl;
  } catch (error) {
    console.error(`❌ Failed to generate combined audio:`, error);
    return undefined;
  }
}

function splitTextIntoChunks(text: string, maxChunkSize: number): string[] {
  if (text.length <= maxChunkSize) {
    return [text];
  }
  
  const chunks: string[] = [];
  let currentChunk = '';
  
  // Split by sentences to maintain natural breaks
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  
  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;
    
    const sentenceWithPunctuation = trimmedSentence + '.';
    
    // If adding this sentence would exceed the limit, save current chunk and start new one
    if (currentChunk.length + sentenceWithPunctuation.length + 1 > maxChunkSize) {
      if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = sentenceWithPunctuation;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentenceWithPunctuation;
    }
  }
  
  // Add the last chunk if it has content
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks.length > 0 ? chunks : [text]; // Fallback to original text if no chunks created
}

async function generateSingleAudioBuffer(pollyClient: PollyClient, text: string): Promise<Buffer | null> {
  try {
    // Ensure text is within Polly's limits (3000 characters)
    const truncatedText = text.length > 2800 ? text.substring(0, 2800) + "..." : text;
    
    const synthesizeCommand = new SynthesizeSpeechCommand({
      Text: truncatedText,
      OutputFormat: 'mp3',
      VoiceId: 'Joanna',
      Engine: 'neural'
    });

    const pollyResponse = await pollyClient.send(synthesizeCommand);
    
    if (!pollyResponse.AudioStream) {
      console.error('No audio stream received from Polly');
      return null;
    }

    return await streamToBuffer(pollyResponse.AudioStream);
  } catch (error) {
    console.error(`❌ Failed to generate single audio buffer:`, error);
    return null;
  }
}

async function streamToBuffer(stream: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    
    stream.on('end', () => {
      resolve(Buffer.concat(chunks as Uint8Array[]));
    });
    
    stream.on('error', (error: Error) => {
      reject(error);
    });
  });
}

async function saveDailyRecommendations(
  stories: StoryInfo[], 
  timestamp: string, 
  combinedAudioUrl?: string
): Promise<void> {
  const dynamoClient = new DynamoDBClient({ 
    region: process.env.AWS_REGION || 'us-west-2' 
  });
  
  const docClient = DynamoDBDocumentClient.from(dynamoClient);
  const tableName = process.env.RECOMMENDATIONS_TABLE_NAME;
  
  if (!tableName) {
    throw new Error('RECOMMENDATIONS_TABLE_NAME environment variable not set');
  }

  const date = new Date(timestamp).toISOString().split('T')[0]; // YYYY-MM-DD format
  const oneYearFromNow = Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60); // TTL in seconds

  console.log(`💾 Saving ${stories.length} recommendations for date: ${date}`);

  // Save individual story recommendations
  const putRequests = stories.map((story, index) => ({
    PutRequest: {
      Item: {
        id: `${story.source}-${index}-${Date.now()}`, // Unique ID for each story (primary key)
        date: date,
        source: story.source,
        title: story.title,
        url: story.url,
        score: story.score,
        author: story.author,
        comments: story.comments,
        timestamp: story.timestamp,
        summary: story.summary || '',
        audioUrl: story.audioUrl || '',
        ttl: oneYearFromNow
      } as DailyRecommendation
    }
  }));

  // Save daily digest metadata
  const digestRecord: DailyDigest = {
    id: `digest-${date}`, // Unique digest ID (primary key)
    date: date,
    source: 'daily-digest',
    totalStories: stories.length,
    timestamp: timestamp,
    combinedAudioUrl: combinedAudioUrl || '',
    emailSent: false, // Will be updated after email is sent
    ttl: oneYearFromNow
  };

  try {
    // Batch write individual recommendations (max 25 items per batch)
    const batches = [];
    for (let i = 0; i < putRequests.length; i += 25) {
      batches.push(putRequests.slice(i, i + 25));
    }

    for (const batch of batches) {
      const batchWriteCommand = new BatchWriteCommand({
        RequestItems: {
          [tableName]: batch
        }
      });
      await docClient.send(batchWriteCommand);
    }

    // Save digest record
    const putDigestCommand = new PutCommand({
      TableName: tableName,
      Item: digestRecord
    });
    await docClient.send(putDigestCommand);

    console.log(`✅ Successfully saved ${stories.length} recommendations and digest for ${date}`);
  } catch (error) {
    console.error('❌ Failed to save recommendations to database:', error);
    throw error;
  }
}

async function updateEmailSentStatus(timestamp: string): Promise<void> {
  const dynamoClient = new DynamoDBClient({ 
    region: process.env.AWS_REGION || 'us-west-2' 
  });
  
  const docClient = DynamoDBDocumentClient.from(dynamoClient);
  const tableName = process.env.RECOMMENDATIONS_TABLE_NAME;
  
  if (!tableName) {
    throw new Error('RECOMMENDATIONS_TABLE_NAME environment variable not set');
  }

  const date = new Date(timestamp).toISOString().split('T')[0];

  try {
    const putCommand = new PutCommand({
      TableName: tableName,
      Item: {
        id: `digest-${date}`,
        emailSent: true,
        lastUpdated: timestamp
      },
      ConditionExpression: 'attribute_exists(#id)',
      ExpressionAttributeNames: {
        '#id': 'id'
      }
    });
    
    await docClient.send(putCommand);
    console.log(`✅ Updated email sent status for ${date}`);
  } catch (error) {
    console.error('❌ Failed to update email sent status:', error);
    // Don't throw error here as it's not critical
  }
}

async function sendEmailSummary(newsletterData: NewsletterData, timestamp: string): Promise<void> {
  const sesClient = new SESClient({ 
    region: process.env.AWS_REGION || 'us-west-2' 
  });

  // Create HTML email content
  const htmlContent = generateEmailHTML(newsletterData, timestamp);
  const textContent = generateEmailText(newsletterData, timestamp);

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
  
  // Update database with email sent status
  try {
    await updateEmailSentStatus(timestamp);
  } catch (error) {
    console.error('❌ Failed to update email sent status in database:', error);
    // Don't fail the email send for this
  }
}

function generateEmailHTML(newsletterData: NewsletterData, timestamp: string): string {
  const date = new Date(timestamp).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  // Add "Play All" button if combined audio is available
  let playAllSection = '';
  if (newsletterData.combinedAudioUrl) {
    playAllSection = `
      <div style="margin-bottom: 30px; padding: 20px; background-color: #f0f8ff; border-radius: 8px; text-align: center; border: 2px solid #ff6600;">
        <h2 style="color: #ff6600; font-size: 20px; margin: 0 0 15px 0;">🎧 Listen to All Stories</h2>
        <a href="${newsletterData.combinedAudioUrl}" style="display: inline-block; padding: 15px 30px; background-color: #ff6600; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 8px rgba(255,102,0,0.3);">
          🎵 Play Full Daily Digest
        </a>
        <p style="margin: 10px 0 0 0; font-size: 14px; color: #666;">Listen to all ${newsletterData.stories.length} story summaries in one continuous audio</p>
      </div>`;
  }

  let storiesHTML = '';
  newsletterData.stories.forEach((story, index) => {
      let sourceIcon, sourceColor, sourceName;
      if (story.source === 'hacker-news') {
        sourceIcon = '📰';
        sourceColor = '#ff6600';
        sourceName = 'Hacker News';
      } else if (story.source === 'github-trending') {
        sourceIcon = '⭐';
        sourceColor = '#24292e';
        sourceName = 'GitHub Trending';
      }
      
    storiesHTML += `
        <div style="margin-bottom: 25px; padding: 15px; background-color: #f9f9f9; border-left: 4px solid ${sourceColor};">
          <div style="display: flex; align-items: center; margin-bottom: 8px;">
            <span style="background-color: ${sourceColor}; color: white; padding: 4px 8px; border-radius: 12px; font-size: 12px; font-weight: bold; margin-right: 10px;">
              ${sourceIcon} ${sourceName}
            </span>
          </div>
        <h3 style="margin: 0 0 10px 0; color: #333;">
            ${index + 1}. <a href="${story.url}" style="color: ${sourceColor}; text-decoration: none;">${story.title}</a>
        </h3>
        <p style="margin: 5px 0; color: #888; font-size: 12px;">
          🕐 Posted: ${new Date(story.timestamp).toLocaleString()}
          </p>`;
    
    if (story.summary) {
      // Convert markdown to HTML for better rendering
      const htmlSummary = story.summary
        .replace(/^#+\s*/gm, '') // Remove all markdown headers (# ## ### etc)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/^\d+\. (.*)/gm, '<div style="margin: 8px 0; padding-left: 15px;"><strong>• $1</strong></div>')
        .replace(/\n\n/g, '</p><p style="margin: 8px 0; line-height: 1.6;">')
        .replace(/\n/g, '<br>');
      
      storiesHTML += `
        <div style="margin-top: 15px; padding: 20px; background-color: #fff; border-radius: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <div style="color: #444; font-size: 14px; line-height: 1.6;">
            <p style="margin: 8px 0; line-height: 1.6;">${htmlSummary}</p>
          </div>`;
      
      
      storiesHTML += `
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
        <div style="text-align: center; margin-bottom: 30px; padding: 20px; background: linear-gradient(135deg, #ff6600, #24292e); color: white; border-radius: 8px;">
            <h1 style="margin: 0;">🚀 Daily Tech Digest</h1>
            <p style="margin: 10px 0 0 0;">Hacker News • GitHub Trending</p>
            <p style="margin: 5px 0 0 0; font-size: 14px;">${date}</p>
        </div>
        
        ${playAllSection}
        
        <div style="margin-bottom: 20px;">
            <h2 style="color: #ff6600;">🔥 Top ${newsletterData.stories.length} Stories</h2>
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

function generateEmailText(newsletterData: NewsletterData, timestamp: string): string {
  const date = new Date(timestamp).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  // Add "Play All" button if combined audio is available
  let playAllText = '';
  if (newsletterData.combinedAudioUrl) {
    playAllText = `
🎧 LISTEN TO ALL STORIES
Play Full Daily Digest: ${newsletterData.combinedAudioUrl}
Listen to all ${newsletterData.stories.length} story summaries in one continuous audio

---

`;
  }

  let storiesText = '';
  newsletterData.stories.forEach((story, index) => {
    let sourceLabel;
    if (story.source === 'hacker-news') {
      sourceLabel = '📰 Hacker News';
    } else if (story.source === 'github-trending') {
      sourceLabel = '⭐ GitHub Trending';
    }
    storiesText += `
${index + 1}. ${story.title} [${sourceLabel}]
   URL: ${story.url}
   Posted: ${new Date(story.timestamp).toLocaleString()}`;
    
    if (story.summary) {
      // Clean up markdown for plain text email
      const cleanSummary = story.summary
        .replace(/^#+\s*/gm, '') // Remove all markdown headers
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
DAILY TECH DIGEST
Hacker News • GitHub Trending
Generated by NewsAgent with AI Summaries
${date}

${playAllText}Top ${newsletterData.stories.length} Items:
${storiesText}
---
This summary was automatically generated by your NewsAgent Lambda function.
Powered by AWS Lambda, Bedrock & Hacker News API
  `;
}
