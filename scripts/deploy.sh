#!/bin/bash

# NewsAgent CDK Deployment Script

set -e

echo "🚀 Starting NewsAgent CDK deployment..."

# Check if AWS CLI is configured
if ! aws sts get-caller-identity > /dev/null 2>&1; then
    echo "❌ AWS CLI is not configured or you don't have valid credentials"
    echo "Please run 'aws configure' first"
    exit 1
fi

echo "✅ AWS credentials are valid"

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Build the project
echo "🔨 Building TypeScript..."
npm run build

# Run tests
echo "🧪 Running tests..."
npm test

# Bootstrap CDK if needed (this is safe to run multiple times)
echo "🥾 Bootstrapping CDK (if needed)..."
npm run bootstrap

# Deploy the stack
echo "🚀 Deploying stack..."
npm run deploy

echo "✅ Deployment completed successfully!"
echo ""
echo "🔍 To monitor your Lambda function:"
echo "1. Check CloudWatch Logs: /aws/lambda/news-agent-hello-world"
echo "2. View EventBridge Rules in AWS Console"
echo "3. The function will be triggered every 5 minutes"
echo ""
echo "🗑️  To clean up resources later, run: npm run destroy"
