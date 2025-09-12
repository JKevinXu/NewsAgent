import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export class NewsAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

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
        USER_AGENT: 'Mozilla/5.0 (compatible; NewsAgent/1.0; +https://github.com/JKevinXu/NewsAgent)'
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Create EventBridge rule for cron job (runs every 30 minutes)
    const cronRule = new events.Rule(this, 'NewsAgentCronRule', {
      ruleName: 'news-agent-cron',
      description: 'Triggers NewsAgent Lambda every 30 minutes to fetch and summarize Hacker News',
      schedule: events.Schedule.expression('rate(30 minutes)'), // Run every 30 minutes (less frequent due to processing time)
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
      value: 'rate(30 minutes)',
      description: 'Schedule expression for the NewsAgent cron job',
      exportName: 'NewsAgent-CronSchedule'
    });
  }
}
