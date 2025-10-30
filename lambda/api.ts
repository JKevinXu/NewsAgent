import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

interface DailyRecommendation {
  id: string;
  date: string;
  source: 'hacker-news' | 'github-trending' | 'arxiv';
  title: string;
  url: string;
  score: number;
  author: string;
  comments: number;
  timestamp: string;
  summary?: string;
  audioUrl?: string;
  ttl: number;
}

interface DailyDigest {
  id: string;
  date: string;
  source: 'daily-digest';
  totalStories: number;
  timestamp: string;
  combinedAudioUrl?: string;
  emailSent: boolean;
  ttl: number;
}

interface ApiResponse {
  success: boolean;
  data?: any;
  error?: string;
  pagination?: {
    hasMore: boolean;
    lastKey?: any;
  };
}

const dynamoClient = new DynamoDBClient({ 
  region: process.env.AWS_REGION || 'us-west-2' 
});

const docClient = DynamoDBDocumentClient.from(dynamoClient);

export const handler = async (
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> => {
  console.log('🚀 NewsAgent API called:', JSON.stringify(event.pathParameters), JSON.stringify(event.queryStringParameters));

  const tableName = process.env.RECOMMENDATIONS_TABLE_NAME;
  if (!tableName) {
    return createErrorResponse(500, 'RECOMMENDATIONS_TABLE_NAME environment variable not set');
  }

  try {
    const path = event.path;
    const method = event.httpMethod;
    const pathParams = event.pathParameters || {};
    const queryParams = event.queryStringParameters || {};

    if (method !== 'GET') {
      return createErrorResponse(405, 'Method not allowed');
    }

    let result: ApiResponse;

    // Route handling
    if (path === '/recommendations') {
      // GET /recommendations - list all recommendations with optional filters
      result = await listRecommendations(queryParams);
    } else if (path.match(/^\/recommendations\/[^\/]+\/digest$/)) {
      // GET /recommendations/{date}/digest - get daily digest for specific date
      const date = pathParams.date;
      if (!date) {
        return createErrorResponse(400, 'Date parameter is required');
      }
      result = await getDailyDigest(date);
    } else if (path.match(/^\/recommendations\/[^\/]+$/)) {
      // GET /recommendations/{date} - get recommendations for specific date
      const date = pathParams.date;
      if (!date) {
        return createErrorResponse(400, 'Date parameter is required');
      }
      result = await getRecommendationsByDate(date, queryParams);
    } else {
      return createErrorResponse(404, 'Endpoint not found');
    }

    return createSuccessResponse(result);

  } catch (error) {
    console.error('❌ API Error:', error);
    return createErrorResponse(500, error instanceof Error ? error.message : 'Internal server error');
  }
};

async function listRecommendations(queryParams: Record<string, string>): Promise<ApiResponse> {
  const limit = parseInt(queryParams.limit || '20');
  const source = queryParams.source;
  const dateFilter = queryParams.date;
  const lastKey = queryParams.lastKey ? JSON.parse(decodeURIComponent(queryParams.lastKey)) : undefined;

  let scanParams: any = {
    TableName: process.env.RECOMMENDATIONS_TABLE_NAME,
    Limit: Math.min(limit, 100), // Cap at 100 items per request
  };

  if (lastKey) {
    scanParams.ExclusiveStartKey = lastKey;
  }

  // Add filters
  let filterExpressions: string[] = [];
  let expressionAttributeValues: any = {};
  let expressionAttributeNames: any = {};

  // Filter out digest records from general listing
  filterExpressions.push('#source <> :digestSource');
  expressionAttributeValues[':digestSource'] = 'daily-digest';
  expressionAttributeNames['#source'] = 'source';

  if (source) {
    filterExpressions.push('#source = :source');
    expressionAttributeValues[':source'] = source;
    expressionAttributeNames['#source'] = 'source';
  }

  if (dateFilter) {
    filterExpressions.push('#date = :date');
    expressionAttributeValues[':date'] = dateFilter;
    expressionAttributeNames['#date'] = 'date';
  }

  if (filterExpressions.length > 0) {
    scanParams.FilterExpression = filterExpressions.join(' AND ');
    scanParams.ExpressionAttributeValues = expressionAttributeValues;
    scanParams.ExpressionAttributeNames = expressionAttributeNames;
  }

  const command = new ScanCommand(scanParams);
  const response = await docClient.send(command);

  return {
    success: true,
    data: {
      recommendations: response.Items || [],
      count: response.Count || 0,
    },
    pagination: {
      hasMore: !!response.LastEvaluatedKey,
      lastKey: response.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(response.LastEvaluatedKey)) : undefined
    }
  };
}

async function getRecommendationsByDate(date: string, queryParams: Record<string, string>): Promise<ApiResponse> {
  const source = queryParams.source;
  
  let queryParams_: any = {
    TableName: process.env.RECOMMENDATIONS_TABLE_NAME,
    IndexName: 'date-index',
    ExpressionAttributeNames: {
      '#date': 'date'
    },
    ExpressionAttributeValues: {
      ':date': date
    }
  };

  if (source) {
    // Query for specific source using sort key
    queryParams_.KeyConditionExpression = '#date = :date AND #source = :source';
    queryParams_.ExpressionAttributeNames['#source'] = 'source';
    queryParams_.ExpressionAttributeValues[':source'] = source;
  } else {
    // Query all sources for the date
    queryParams_.KeyConditionExpression = '#date = :date';
    // Note: Can't filter on sort key 'source' in GSI, so we get all records for this date
    // The digest records use 'daily-digest' as source, which we can filter in application logic if needed
  }

  const command = new QueryCommand(queryParams_);
  const response = await docClient.send(command);

  // Filter out digest records if no specific source was requested
  let filteredItems = response.Items || [];
  if (!source) {
    filteredItems = filteredItems.filter(item => item.source !== 'daily-digest');
  }

  return {
    success: true,
    data: {
      date: date,
      recommendations: filteredItems,
      count: filteredItems.length,
    }
  };
}

async function getDailyDigest(date: string): Promise<ApiResponse> {
  const command = new GetCommand({
    TableName: process.env.RECOMMENDATIONS_TABLE_NAME,
    Key: {
      id: `digest-${date}`
    }
  });

  const response = await docClient.send(command);

  if (!response.Item) {
    return {
      success: false,
      error: `No daily digest found for date: ${date}`
    };
  }

  return {
    success: true,
    data: {
      digest: response.Item
    }
  };
}

function createSuccessResponse(data: ApiResponse): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Amz-Date, Authorization, X-Api-Key',
    },
    body: JSON.stringify(data),
  };
}

function createErrorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Amz-Date, Authorization, X-Api-Key',
    },
    body: JSON.stringify({
      success: false,
      error: message
    }),
  };
}
