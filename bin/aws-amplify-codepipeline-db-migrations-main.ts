#!/usr/bin/env node
import 'source-map-support/register';
import cdk = require('aws-cdk-lib');
import { AwsAmplifyCodepipelineDbMigrationsMainStack } from '../lib/aws-amplify-codepipeline-db-migrations-main-stack';

const app = new cdk.App();
new AwsAmplifyCodepipelineDbMigrationsMainStack(
    app,
    'AwsAmplifyCodepipelineDbMigrationsMainStack', {
        stackName: 'AwsAmplifyCodepipelineDbMigrationsMainStack'
    }
);