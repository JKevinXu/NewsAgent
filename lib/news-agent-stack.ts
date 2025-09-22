import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class NewsAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create DynamoDB table for storing daily recommendations
    const recommendationsTable = new dynamodb.Table(this, 'NewsAgentRecommendations', {
      tableName: 'newsagent-recommendations',
      partitionKey: { name: 'date', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl', // Auto-delete old records after 365 days
    });

    // Add GSI for querying by source
    recommendationsTable.addGlobalSecondaryIndex({
      indexName: 'source-date-index',
      partitionKey: { name: 'source', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'date', type: dynamodb.AttributeType.STRING },
    });

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
  }
}
