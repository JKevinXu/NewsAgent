import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';

export const handler = async (
  event: APIGatewayProxyEvent | any,
  context: Context
): Promise<APIGatewayProxyResult | any> => {
  console.log('Lambda function invoked!');
  console.log('Event:', JSON.stringify(event, null, 2));
  console.log('Context:', JSON.stringify(context, null, 2));

  const currentTime = new Date().toISOString();
  const message = `Hello World from NewsAgent Lambda! Current time: ${currentTime}`;

  // Log the message
  console.log(message);

  // If this is triggered by EventBridge (CloudWatch Events), return simple response
  if (event.source === 'aws.events') {
    console.log('Triggered by scheduled event (cron job)');
    return {
      statusCode: 200,
      message: message,
      timestamp: currentTime,
      source: 'scheduled-event'
    };
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
    body: JSON.stringify({
      message: message,
      timestamp: currentTime,
      source: 'api-gateway',
      requestId: context.awsRequestId
    }),
  };
};
