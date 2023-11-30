import cdk = require('aws-cdk-lib');
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipelineactions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs/lib/construct';

export class AwsAmplifyCodepipelineDbMigrationsMainStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    
    // Create VPC
    const vpc = new ec2.Vpc(
      this,
      'VPC', {
        vpcName:  `${props?.stackName}-VPC`,
        cidr: this.node.tryGetContext('vpcCIDR'),
        natGateways: 1,
        maxAzs: 2,
        subnetConfiguration: [
          {
            name: 'private-',
            subnetType: ec2.SubnetType.PRIVATE,
            cidrMask: 26,
          },
          {
            name: 'public-',
            subnetType: ec2.SubnetType.PUBLIC,
            cidrMask: 26,
          },
        ]
      }
    );

    // Create Security Groups
    const codeBuildSecurityGroup = new ec2.SecurityGroup(
      this, "CodeBuildSecurityGroup", {
        vpc: vpc,
        securityGroupName: `${props?.stackName}-CodeBuildSecurityGroup`,
      });
    const databaseSecurityGroup = new ec2.SecurityGroup(
      this, "DatabaseSecurityGroup", {
        vpc: vpc,
        securityGroupName: `${props?.stackName}-DatabaseSecurityGroup`,
      });
    databaseSecurityGroup.addIngressRule(
      codeBuildSecurityGroup,
      ec2.Port.tcp(5432),);


    // Create Database Cluster
    const databaseCluster = this.createDatabaseCluster(this, vpc, databaseSecurityGroup, props);
  
    // Create Bastion Host
    const bastionHost = new ec2.BastionHostLinux(this, 'BastionHost', {
      vpc,
      securityGroup: codeBuildSecurityGroup,
      instanceName: `${props?.stackName}-BastionHost`,
    });

    // Create Amplify Stack
    const codeCommitRepository = this.createCodeCommitRepository(this, props);

    const amplifyApp = this.createAmplifyApp(this, props);
    
    // Create CI/CD Pipeline
    this.createCodePipeline(this, props ?? {}, vpc, databaseCluster, codeCommitRepository, amplifyApp, codeBuildSecurityGroup);
    
    // Outputs
    new cdk.CfnOutput(this, 'AmplifyAppId', {
      value: amplifyApp.attrAppId,
      description: 'The ID of the Amplify Application',
      exportName: 'amplifyAppId',
    });
    new cdk.CfnOutput(this, 'CodeCommitHTTPCloneUrl', {
      value: codeCommitRepository.repositoryCloneUrlHttp,
      description: 'The git HTTP clone URL',
      exportName: 'codeCommitHTTPCloneUrl',
    });
  }
  
  createDatabaseCluster(
    scope: Construct,
    vpc: ec2.Vpc,
    databaseSecurityGroup: ec2.SecurityGroup,
    props?: cdk.StackProps): rds.ServerlessCluster{
    return new rds.ServerlessCluster(
      scope,
      'ServerlessCluster',
      {
        clusterIdentifier: `${props?.stackName}-ServerlessCluster`,
        engine: rds.DatabaseClusterEngine.auroraPostgres({version: rds.AuroraPostgresEngineVersion.VER_11_13}),
        vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE,
        },
        securityGroups: [databaseSecurityGroup],
        enableDataApi: false,
        backupRetention: cdk.Duration.days(1),
        defaultDatabaseName: 'postgres',
        credentials: {
          'username': 'migrationstest'
        },
        scaling: {
          autoPause: cdk.Duration.minutes(10),
          minCapacity: rds.AuroraCapacityUnit.ACU_2,
          maxCapacity: rds.AuroraCapacityUnit.ACU_2,
        },
        parameterGroup: rds.ParameterGroup.fromParameterGroupName(scope, 'ParameterGroup', 'default.aurora-postgresql11'),
      }
    );
  }
  
  createCodeCommitRepository(
    scope: Construct,
    props?: cdk.StackProps): codecommit.Repository{
    return new codecommit.Repository(
      scope,
      'CodeCommitRepository',
      {
        repositoryName: `${props?.stackName}-CodeCommitRepository`.toLowerCase(),
        description:
          "CodeCommit repository that will be used as the source repository for the sample react app and the cdk app",
      }
    );
  }
  
  createAmplifyApp(
    scope: Construct,
    props?: cdk.StackProps): amplify.CfnApp{
    return new amplify.CfnApp(
      scope,
      'AmplifyReactApp',
      {
        'name': `${props?.stackName}-AwsAmplifyCodepipelineDbMigrations`
      }
    );
  }
  
  createCodePipeline(
    scope: Construct,
    props: cdk.StackProps,
    vpc: ec2.Vpc,
    databaseCluster: rds.ServerlessCluster,
    codeCommitRepository: codecommit.Repository,
    amplifyApp: amplify.CfnApp,
    codeBuildSecurityGroup: ec2.SecurityGroup): codepipeline.Pipeline {
    // Create necessary secrets (e.g. Access Keys)
    // Create Amplify CodeBuild Project
    const amplifyUserAccessKeyID = new secretsmanager.Secret(
      scope,
      'AmplifyUserAccessKeyIDSecret',
      {
        secretName: `/app/${(props?.stackName??'').replace('-','')}/CodeBuild/dev/AMPLIFY_USER_ACCESS_KEY_ID`,
        secretStringBeta1: secretsmanager.SecretStringValueBeta1.fromUnsafePlaintext('REPLACE-IN-CONSOLE-WITH-ACTUAL-VALUE'),
      }
    );

    const amplifyUserSecretAccessKey = new secretsmanager.Secret(
      scope,
      'AmplifyUserSecretAccessKeySecret',
      {
        secretName: `/app/${(props?.stackName??'').replace('-','')}/CodeBuild/dev/AMPLIFY_USER_SECRET_ACCESS_KEY`,
        secretStringBeta1: secretsmanager.SecretStringValueBeta1.fromUnsafePlaintext('REPLACE-IN-CONSOLE-WITH-ACTUAL-VALUE'),
      }
    );

    const codeBuildDeployAmplify = new codebuild.Project(
      scope,
      `${props?.stackName}-CodeBuildDeployAmplify`,
      {
        environment: {
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
          computeType: codebuild.ComputeType.LARGE
        },
        buildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
          'env': {
            'secrets-manager': {
              'AMPLIFY_USER_ACCESS_KEY_ID': amplifyUserAccessKeyID.secretName,
              'AMPLIFY_USER_SECRET_ACCESS_KEY': amplifyUserSecretAccessKey.secretName
            }
          },
          'phases': {
            'install':{
              'runtime-versions':{
                'python': '3.8',
                'nodejs': '12'
              },
              'commands': [
                'npm install -g @aws-amplify/cli', // Specify an Amplify CLI version here, or add to frontend npm dependencies
                'npm install'
              ]
            },
            'build':{
              'commands': [
                'npx amplify init --yes --amplify "{\\"envName\\":\\"dev\\",\\"defaultEditor\\":\\"code\\"}" --providers "{\\"awscloudformation\\":{\\"useProfile\\":false,\\"accessKeyId\\":\\"$AMPLIFY_USER_ACCESS_KEY_ID\\",\\"secretAccessKey\\":\\"$AMPLIFY_USER_SECRET_ACCESS_KEY\\",\\"region\\":\\"us-east-1\\"}}"',
                'npx amplify configure project --yes --amplify "{\\"envName\\":\\"dev\\",\\"defaultEditor\\":\\"code\\"}" --providers "{\\"awscloudformation\\":{\\"useProfile\\":false,\\"accessKeyId\\":\\"$AMPLIFY_USER_ACCESS_KEY_ID\\",\\"secretAccessKey\\":\\"$AMPLIFY_USER_SECRET_ACCESS_KEY\\",\\"region\\":\\"us-east-1\\"}}" --frontend "{\\"frontend\\":\\"javascript\\",\\"framework\\":\\"react\\",\\"config\\":{\\"SourceDir\\":\\"src\\",\\"DistributionDir\\":\\"build\\",\\"BuildCommand\\":\\"npm run-script build\\",\\"StartCommand\\":\\"npm run-script start\\"}}"',
                'npx amplify publish --invalidateCloudFront --yes'
                ]
            },
          }
        } ),
      }
    );
    codeBuildDeployAmplify.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [amplifyUserAccessKeyID.secretArn, amplifyUserSecretAccessKey.secretArn],
    }));
    
    // Create DB Migrations CodeBuild Project (run with the DB security group)
    const codeBuildDeployDatabase = new codebuild.Project(
      scope,
      `${props?.stackName}-CodeBuildDeployDatabase`,
      {
        vpc: vpc,
        subnetSelection: {
          subnetType: ec2.SubnetType.PRIVATE,
        },
        securityGroups: [codeBuildSecurityGroup],
        environment: {
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
          computeType: codebuild.ComputeType.LARGE,
        },
        buildSpec: codebuild.BuildSpec.fromObject( {
          'version': '0.2',
          'env': {
            'secrets-manager': {
              'DATABASE_SECRET_ENGINE': `${databaseCluster.secret?.secretName}:engine`,
              'DATABASE_SECRET_USERNAME': `${databaseCluster.secret?.secretName}:username`,
              'DATABASE_SECRET_PASSWORD': `${databaseCluster.secret?.secretName}:password`,
              'DATABASE_SECRET_HOST': `${databaseCluster.secret?.secretName}:host`,
              'DATABASE_SECRET_DBNAME': `${databaseCluster.secret?.secretName}:dbname`,
            }
          },
          'phases': {
            'install':{
              'commands': [
                'yum install -y python3-devel postgresql-devel',
                'yum install -y jq',
                ]
            },
            'pre_build':{
              'commands': [
                'python3 -m venv env',
                'source env/bin/activate',
                'pip install psycopg2-binary==2.9.3',
                'pip install postgres==4.0',
                'pip install SQLAlchemy==1.4.41',
                'pip install alembic==1.11.1',
                'pip install boto3',
                'pip install pytest',
                'sed -i "s/sqlalchemy.url = [^\\n]*/sqlalchemy.url = postgresql:\\/\\/$DATABASE_SECRET_USERNAME:$DATABASE_SECRET_PASSWORD@$DATABASE_SECRET_HOST\\/$DATABASE_SECRET_DBNAME/" alembic.ini',
                ]
            },
            'build':{
              'commands': [
                'alembic upgrade head',
                ]
            },
          }
        } ),
      }
    );
    codeBuildDeployDatabase.addToRolePolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [databaseCluster.secret?.secretArn ?? ''],
    }));
    
    // Create Pipeline
    const pipelineSourceOutput = new codepipeline.Artifact('SourceArtifact');
    const pipelineSourceStage = {
      stageName: 'Source',
      actions: [
        new codepipelineactions.CodeCommitSourceAction({
          actionName: 'Source',
          repository: codeCommitRepository,
          output: pipelineSourceOutput,
          trigger: codepipelineactions.CodeCommitTrigger.EVENTS
        })
      ]
    };
    const pipelineDeployStage = {
      stageName: 'Deploy',
      actions: [
        new codepipelineactions.CodeBuildAction({
          actionName: 'DeployAmplify',
          project: codeBuildDeployAmplify,
          input: pipelineSourceOutput
        }),
        new codepipelineactions.CodeBuildAction({
          actionName: 'DeployDatabase',
          project: codeBuildDeployDatabase,
          input: pipelineSourceOutput
        }),
      ]
    };
    return new codepipeline.Pipeline(
      scope,
      'AmplifyAndDBCodePipeline',
      {
        pipelineName: `${props?.stackName}-AmplifyAndDBCodePipeline`,
        stages: [
          pipelineSourceStage,
          pipelineDeployStage
        ]
      }
    );
    }
}