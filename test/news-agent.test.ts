import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as NewsAgent from '../lib/news-agent-stack';

test('Lambda Function Created', () => {
  const app = new cdk.App();
  const stack = new NewsAgent.NewsAgentStack(app, 'MyTestStack');
  const template = Template.fromStack(stack);

  // Check that a Lambda function is created
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs18.x',
    Handler: 'hello-world.handler',
    FunctionName: 'news-agent-hello-world'
  });
});

test('EventBridge Rule Created', () => {
  const app = new cdk.App();
  const stack = new NewsAgent.NewsAgentStack(app, 'MyTestStack');
  const template = Template.fromStack(stack);

  // Check that an EventBridge rule is created
  template.hasResourceProperties('AWS::Events::Rule', {
    ScheduleExpression: 'rate(5 minutes)',
    State: 'ENABLED'
  });
});

test('Lambda has correct IAM permissions', () => {
  const app = new cdk.App();
  const stack = new NewsAgent.NewsAgentStack(app, 'MyTestStack');
  const template = Template.fromStack(stack);

  // Check that Lambda execution role is created
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: [
        {
          Action: 'sts:AssumeRole',
          Effect: 'Allow',
          Principal: {
            Service: 'lambda.amazonaws.com'
          }
        }
      ]
    }
  });
});
