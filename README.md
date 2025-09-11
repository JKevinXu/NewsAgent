# NewsAgent CDK Project

A CDK project that deploys a Lambda function with a CloudWatch cron job for automated execution.

## Architecture

This project creates:
- **Lambda Function**: A Hello World function that logs messages and handles both scheduled events and API calls
- **EventBridge Rule**: A cron job that triggers the Lambda function every 5 minutes
- **CloudWatch Logs**: Automatic logging with 1-week retention

## Prerequisites

1. **AWS CLI** configured with appropriate credentials
2. **Node.js** (version 16 or later)
3. **AWS CDK** CLI installed globally: `npm install -g aws-cdk`

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Bootstrap your AWS environment (first time only):
   ```bash
   npm run bootstrap
   ```

## Deployment

1. Build the TypeScript code:
   ```bash
   npm run build
   ```

2. Deploy the stack:
   ```bash
   npm run deploy
   ```

3. To see what will be deployed without actually deploying:
   ```bash
   npm run synth
   ```

## Testing

After deployment, you can:

1. **Check CloudWatch Logs**: The Lambda function will be triggered every 5 minutes and log messages
2. **Manual Invocation**: Test the function directly in the AWS Console
3. **View EventBridge Rules**: Check the AWS Console to see the scheduled rule

## Configuration

### Cron Schedule
The current schedule is set to `rate(5 minutes)`. You can modify this in `lib/news-agent-stack.ts`:

```typescript
schedule: events.Schedule.expression('rate(5 minutes)')
```

Common cron expressions:
- `rate(1 minute)` - Every minute
- `rate(5 minutes)` - Every 5 minutes
- `rate(1 hour)` - Every hour
- `cron(0 12 * * ? *)` - Daily at noon UTC
- `cron(0 18 ? * MON-FRI *)` - Weekdays at 6 PM UTC

### Lambda Configuration
You can modify the Lambda function settings in `lib/news-agent-stack.ts`:
- Memory size (currently 128 MB)
- Timeout (currently 5 minutes)
- Environment variables
- Log retention period

## Monitoring

- **CloudWatch Logs**: Check `/aws/lambda/news-agent-hello-world` log group
- **CloudWatch Metrics**: Lambda invocation metrics
- **EventBridge**: Rule execution metrics

## Cleanup

To remove all resources:
```bash
npm run destroy
```

## Project Structure

```
├── bin/
│   └── news-agent.ts          # CDK app entry point
├── lib/
│   └── news-agent-stack.ts    # Main CDK stack definition
├── lambda/
│   └── hello-world.ts         # Lambda function code
├── cdk.json                   # CDK configuration
├── package.json               # Dependencies and scripts
└── tsconfig.json              # TypeScript configuration
```

## Commands

- `npm run build` - Compile TypeScript to JavaScript
- `npm run watch` - Watch for changes and compile
- `npm run test` - Run tests
- `npm run cdk` - Run CDK CLI commands
- `npm run deploy` - Deploy the stack
- `npm run destroy` - Delete the stack
- `npm run synth` - Synthesize CloudFormation template
- `npm run bootstrap` - Bootstrap CDK in your AWS account
