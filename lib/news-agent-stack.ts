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
    const helloWorldLambda = new lambda.Function(this, 'HelloWorldFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'hello-world.handler',
      code: lambda.Code.fromAsset('lambda'),
      functionName: 'news-agent-hello-world',
      description: 'Hello World Lambda function for NewsAgent',
      timeout: cdk.Duration.minutes(5),
      memorySize: 128,
      environment: {
        NODE_ENV: 'production',
        LOG_LEVEL: 'info'
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Create EventBridge rule for cron job (runs every 5 minutes)
    const cronRule = new events.Rule(this, 'HelloWorldCronRule', {
      ruleName: 'news-agent-hello-world-cron',
      description: 'Triggers HelloWorld Lambda every 5 minutes',
      schedule: events.Schedule.expression('rate(5 minutes)'), // Run every 5 minutes
      enabled: true,
    });

    // Add Lambda function as target for the cron rule
    cronRule.addTarget(new targets.LambdaFunction(helloWorldLambda, {
      event: events.RuleTargetInput.fromObject({
        source: 'aws.events',
        'detail-type': 'Scheduled Event',
        detail: {
          message: 'Hello from scheduled cron job!',
          timestamp: events.EventField.fromPath('$.time')
        }
      })
    }));

    // Output the Lambda function ARN and name
    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      value: helloWorldLambda.functionArn,
      description: 'ARN of the Hello World Lambda function',
      exportName: 'NewsAgent-HelloWorld-Lambda-Arn'
    });

    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: helloWorldLambda.functionName,
      description: 'Name of the Hello World Lambda function',
      exportName: 'NewsAgent-HelloWorld-Lambda-Name'
    });

    // Output the EventBridge rule ARN
    new cdk.CfnOutput(this, 'CronRuleArn', {
      value: cronRule.ruleArn,
      description: 'ARN of the EventBridge cron rule',
      exportName: 'NewsAgent-CronRule-Arn'
    });

    // Output the cron schedule
    new cdk.CfnOutput(this, 'CronSchedule', {
      value: 'rate(5 minutes)',
      description: 'Schedule expression for the cron job',
      exportName: 'NewsAgent-CronSchedule'
    });
  }
}
