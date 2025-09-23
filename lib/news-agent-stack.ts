import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';

export class NewsAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Reference existing DynamoDB table for storing daily recommendations
    const recommendationsTable = dynamodb.Table.fromTableName(this, 'NewsAgentRecommendations', 'newsagent-recommendations');

    // Create S3 bucket for audio files
    const audioBucket = new s3.Bucket(this, 'NewsAgentAudioBucket', {
      bucketName: `newsagent-audio-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      publicReadAccess: true,
      blockPublicAccess: {
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false,
      },
      cors: [
        {
          allowedHeaders: ['*'],
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['*'],
        },
      ],
    });

    // Create Lambda function
    const newsAgentLambda = new lambda.Function(this, 'NewsAgentFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'hello-world.handler',
      code: lambda.Code.fromAsset('lambda-package'),
      functionName: 'news-agent',
      description: 'NewsAgent Lambda function that reads Hacker News and summarizes articles',
      timeout: cdk.Duration.minutes(10), // Increased timeout for web scraping
      memorySize: 512, // Increased memory for processing multiple articles
      environment: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        USER_AGENT: 'Mozilla/5.0 (compatible; NewsAgent/1.0; +https://github.com/JKevinXu/NewsAgent)',
        SES_FROM_EMAIL: 'xkevinj@gmail.com', // Using your Gmail as sender for verification
        AUDIO_BUCKET_NAME: audioBucket.bucketName,
        RECOMMENDATIONS_TABLE_NAME: recommendationsTable.tableName
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Add SES permissions to the Lambda function
    newsAgentLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ses:SendEmail',
        'ses:SendRawEmail'
      ],
      resources: ['*'], // You can restrict this to specific verified email addresses
    }));

    // Add Bedrock permissions to the Lambda function
    newsAgentLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel'
      ],
      resources: ['*'], // You can restrict this to specific Bedrock models
    }));

    // Add Polly permissions to the Lambda function
    newsAgentLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'polly:SynthesizeSpeech'
      ],
      resources: ['*'],
    }));

    // Add S3 permissions for audio bucket
    audioBucket.grantReadWrite(newsAgentLambda);

    // Add DynamoDB permissions to the Lambda function
    recommendationsTable.grantReadWriteData(newsAgentLambda);

    // Create API Lambda function for database access
    const apiLambda = new lambda.Function(this, 'NewsAgentApiFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'api.handler',
      code: lambda.Code.fromAsset('lambda-package'),
      functionName: 'news-agent-api',
      description: 'NewsAgent API function for querying recommendations database',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info',
        RECOMMENDATIONS_TABLE_NAME: recommendationsTable.tableName
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Add DynamoDB permissions to the API Lambda function
    apiLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:Query',
        'dynamodb:GetItem',
        'dynamodb:Scan'
      ],
      resources: [
        `arn:aws:dynamodb:${this.region}:${this.account}:table/newsagent-recommendations`,
        `arn:aws:dynamodb:${this.region}:${this.account}:table/newsagent-recommendations/index/*`
      ]
    }));

    // Create API Gateway
    const api = new apigateway.RestApi(this, 'NewsAgentApi', {
      restApiName: 'NewsAgent API',
      description: 'API for accessing NewsAgent recommendations database',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key'],
      },
    });

    // Create API resources and methods
    const recommendationsResource = api.root.addResource('recommendations');
    
    // GET /recommendations - get all recommendations with optional date filter
    recommendationsResource.addMethod('GET', new apigateway.LambdaIntegration(apiLambda), {
      requestParameters: {
        'method.request.querystring.date': false,
        'method.request.querystring.source': false,
        'method.request.querystring.limit': false,
        'method.request.querystring.lastKey': false,
      },
    });

    // GET /recommendations/{date} - get recommendations for specific date
    const dateResource = recommendationsResource.addResource('{date}');
    dateResource.addMethod('GET', new apigateway.LambdaIntegration(apiLambda));

    // GET /recommendations/{date}/digest - get daily digest for specific date
    const digestResource = dateResource.addResource('digest');
    digestResource.addMethod('GET', new apigateway.LambdaIntegration(apiLambda));

    // Create EventBridge rule for cron job (runs daily at 6 AM UTC+8 / 10 PM UTC)
    const cronRule = new events.Rule(this, 'NewsAgentCronRule', {
      ruleName: 'news-agent-cron',
      description: 'Triggers NewsAgent Lambda daily at 6 AM UTC+8 (10 PM UTC) to fetch and summarize Hacker News',
      schedule: events.Schedule.expression('cron(0 22 * * ? *)'), // Daily at 10 PM UTC (6 AM UTC+8)
      enabled: true,
    });

    // Add Lambda function as target for the cron rule
    cronRule.addTarget(new targets.LambdaFunction(newsAgentLambda, {
      event: events.RuleTargetInput.fromObject({
        source: 'aws.events',
        'detail-type': 'Scheduled News Agent',
        detail: {
          message: 'Scheduled NewsAgent execution to fetch and summarize Hacker News',
          timestamp: events.EventField.fromPath('$.time'),
          action: 'fetch-summarize-news'
        }
      })
    }));

    // Output the Lambda function ARN and name
    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      value: newsAgentLambda.functionArn,
      description: 'ARN of the NewsAgent Lambda function',
      exportName: 'NewsAgent-Lambda-Arn'
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: newsAgentLambda.functionName,
      description: 'Name of the NewsAgent Lambda function',
      exportName: 'NewsAgent-Lambda-Name'
    });

    // Output the EventBridge rule ARN
    new cdk.CfnOutput(this, 'CronRuleArn', {
      value: cronRule.ruleArn,
      description: 'ARN of the NewsAgent EventBridge cron rule',
      exportName: 'NewsAgent-CronRule-Arn'
    });

    // Output the cron schedule
    new cdk.CfnOutput(this, 'CronSchedule', {
      value: 'cron(0 22 * * ? *)',
      description: 'Schedule expression for the NewsAgent cron job (Daily at 6 AM UTC+8)',
      exportName: 'NewsAgent-CronSchedule'
    });

    // Output the DynamoDB table name
    new cdk.CfnOutput(this, 'RecommendationsTableName', {
      value: recommendationsTable.tableName,
      description: 'Name of the DynamoDB table storing daily recommendations',
      exportName: 'NewsAgent-RecommendationsTable-Name'
    });

    // Output the API Gateway URL
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: api.url,
      description: 'URL of the NewsAgent API Gateway',
      exportName: 'NewsAgent-Api-Url'
    });

    // Output the API Lambda function ARN
    new cdk.CfnOutput(this, 'ApiLambdaFunctionArn', {
      value: apiLambda.functionArn,
      description: 'ARN of the NewsAgent API Lambda function',
      exportName: 'NewsAgent-ApiLambda-Arn'
    });
  }
}
