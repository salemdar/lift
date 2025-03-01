import { Bucket } from "@aws-cdk/aws-s3";
import {
    AllowedMethods,
    CachePolicy,
    Distribution,
    FunctionEventType,
    HttpVersion,
    ViewerProtocolPolicy,
} from "@aws-cdk/aws-cloudfront";
import * as cloudfront from "@aws-cdk/aws-cloudfront";
import type { Construct as CdkConstruct } from "@aws-cdk/core";
import { CfnOutput, RemovalPolicy } from "@aws-cdk/core";
import type { FromSchema } from "json-schema-to-ts";
import chalk from "chalk";
import { S3Origin } from "@aws-cdk/aws-cloudfront-origins";
import * as acm from "@aws-cdk/aws-certificatemanager";
import { flatten } from "lodash";
import type { AwsProvider } from "@lift/providers";
import { AwsConstruct } from "@lift/constructs/abstracts";
import type { ConstructCommands } from "@lift/constructs";
import type { Progress } from "../../utils/logger";
import { getUtils } from "../../utils/logger";
import { s3Sync } from "../../utils/s3-sync";
import ServerlessError from "../../utils/error";
import { emptyBucket, invalidateCloudFrontCache } from "../../classes/aws";
import { redirectToMainDomain } from "../../classes/cloudfrontFunctions";

const STATIC_WEBSITE_DEFINITION = {
    type: "object",
    properties: {
        type: { const: "static-website" },
        path: { type: "string" },
        domain: {
            anyOf: [
                { type: "string" },
                {
                    type: "array",
                    items: { type: "string" },
                },
            ],
        },
        certificate: { type: "string" },
        security: {
            type: "object",
            properties: {
                allowIframe: { type: "boolean" },
            },
            additionalProperties: false,
        },
        errorPage: { type: "string" },
        redirectToMainDomain: { type: "boolean" },
    },
    additionalProperties: false,
    required: ["path"],
} as const;

type Configuration = FromSchema<typeof STATIC_WEBSITE_DEFINITION>;

export class StaticWebsite extends AwsConstruct {
    public static type = "static-website";
    public static schema = STATIC_WEBSITE_DEFINITION;
    public static commands: ConstructCommands = {
        upload: {
            usage: "Upload files directly to S3 without going through a CloudFormation deployment.",
            handler: StaticWebsite.prototype.uploadWebsiteCommand,
        },
    };

    private readonly distribution: Distribution;
    private readonly domains: string[] | undefined;
    private readonly bucketNameOutput: CfnOutput;
    private readonly domainOutput: CfnOutput;
    private readonly cnameOutput: CfnOutput;
    private readonly distributionIdOutput: CfnOutput;

    constructor(
        scope: CdkConstruct,
        private readonly id: string,
        private readonly configuration: Configuration,
        private readonly provider: AwsProvider
    ) {
        super(scope, id);

        if (configuration.domain !== undefined && configuration.certificate === undefined) {
            throw new ServerlessError(
                `Invalid configuration for the static website '${id}': if a domain is configured, then a certificate ARN must be configured in the 'certificate' option.\n` +
                    "See https://github.com/getlift/lift/blob/master/docs/static-website.md#custom-domain",
                "LIFT_INVALID_CONSTRUCT_CONFIGURATION"
            );
        }

        const bucket = new Bucket(this, "Bucket", {
            // Enable static website hosting
            websiteIndexDocument: "index.html",
            websiteErrorDocument: this.errorResponseDocument(),
            // Required when static website hosting is enabled
            publicReadAccess: true,
            // For a static website, the content is code that should be versioned elsewhere
            removalPolicy: RemovalPolicy.DESTROY,
        });

        // Cast the domains to an array
        this.domains = configuration.domain !== undefined ? flatten([configuration.domain]) : undefined;
        const certificate =
            configuration.certificate !== undefined
                ? acm.Certificate.fromCertificateArn(this, "Certificate", configuration.certificate)
                : undefined;

        const functionAssociations = [
            {
                function: this.createResponseFunction(),
                eventType: FunctionEventType.VIEWER_RESPONSE,
            },
        ];

        const requestFunction = this.createRequestFunction();

        if (requestFunction !== null) {
            functionAssociations.push({
                function: requestFunction,
                eventType: FunctionEventType.VIEWER_REQUEST,
            });
        }

        this.distribution = new Distribution(this, "CDN", {
            comment: `${provider.stackName} ${id} website CDN`,
            defaultBehavior: {
                // Origins are where CloudFront fetches content
                origin: new S3Origin(bucket),
                allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
                // Use the "Managed-CachingOptimized" policy
                // See https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-policies-list
                cachePolicy: CachePolicy.CACHING_OPTIMIZED,
                viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                functionAssociations: functionAssociations,
            },
            // Enable http2 transfer for better performances
            httpVersion: HttpVersion.HTTP2,
            certificate: certificate,
            domainNames: this.domains,
        });

        // CloudFormation outputs
        this.bucketNameOutput = new CfnOutput(this, "BucketName", {
            description: "Name of the bucket that stores the static website.",
            value: bucket.bucketName,
        });
        let websiteDomain: string = this.distribution.distributionDomainName;
        if (configuration.domain !== undefined) {
            // In case of multiple domains, we take the first one
            websiteDomain = typeof configuration.domain === "string" ? configuration.domain : configuration.domain[0];
        }
        this.domainOutput = new CfnOutput(this, "Domain", {
            description: "Website domain name.",
            value: websiteDomain,
        });
        this.cnameOutput = new CfnOutput(this, "CloudFrontCName", {
            description: "CloudFront CNAME.",
            value: this.distribution.distributionDomainName,
        });
        this.distributionIdOutput = new CfnOutput(this, "DistributionId", {
            description: "ID of the CloudFront distribution.",
            value: this.distribution.distributionId,
        });
    }

    variables(): Record<string, unknown> {
        return {
            cname: this.distribution.distributionDomainName,
        };
    }

    outputs(): Record<string, () => Promise<string | undefined>> {
        return {
            url: () => this.getUrl(),
            cname: () => this.getCName(),
        };
    }

    async postDeploy(): Promise<void> {
        await this.uploadWebsite();
    }

    async uploadWebsiteCommand(): Promise<void> {
        getUtils().log(`Deploying the static website '${this.id}'`);

        const fileChangeCount = await this.uploadWebsite();

        const domain = await this.getDomain();
        if (domain !== undefined) {
            getUtils().log();
            getUtils().log.success(`Deployed https://${domain} ${chalk.gray(`(${fileChangeCount} files changed)`)}`);
        }
    }

    private async uploadWebsite(): Promise<number> {
        const bucketName = await this.getBucketName();
        if (bucketName === undefined) {
            throw new ServerlessError(
                `Could not find the bucket in which to deploy the '${this.id}' website: did you forget to run 'serverless deploy' first?`,
                "LIFT_MISSING_STACK_OUTPUT"
            );
        }

        const progress = getUtils().progress;
        let uploadProgress: Progress | undefined;
        if (progress) {
            uploadProgress = progress.create({
                message: `Uploading directory '${this.configuration.path}' to bucket '${bucketName}'`,
            });
            getUtils().log.verbose(`Uploading directory '${this.configuration.path}' to bucket '${bucketName}'`);
        } else {
            getUtils().log(`Uploading directory '${this.configuration.path}' to bucket '${bucketName}'`);
        }
        const { hasChanges, fileChangeCount } = await s3Sync({
            aws: this.provider,
            localPath: this.configuration.path,
            bucketName,
        });
        if (hasChanges) {
            if (uploadProgress) {
                uploadProgress.update(`Clearing CloudFront DNS cache`);
            } else {
                getUtils().log(`Clearing CloudFront DNS cache`);
            }
            await this.clearCDNCache();
        }

        if (uploadProgress) {
            uploadProgress.remove();
        }

        return fileChangeCount;
    }

    private async clearCDNCache(): Promise<void> {
        const distributionId = await this.getDistributionId();
        if (distributionId === undefined) {
            return;
        }
        await invalidateCloudFrontCache(this.provider, distributionId);
    }

    async preRemove(): Promise<void> {
        const bucketName = await this.getBucketName();
        if (bucketName === undefined) {
            // No bucket found => nothing to delete!
            return;
        }

        getUtils().log(
            `Emptying S3 bucket '${bucketName}' for the '${this.id}' static website, else CloudFormation will fail (it cannot delete a non-empty bucket)`
        );
        await emptyBucket(this.provider, bucketName);
    }

    async getUrl(): Promise<string | undefined> {
        const domain = await this.getDomain();
        if (domain === undefined) {
            return undefined;
        }

        return `https://${domain}`;
    }

    async getBucketName(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.bucketNameOutput);
    }

    async getDomain(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.domainOutput);
    }

    async getCName(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.cnameOutput);
    }

    async getDistributionId(): Promise<string | undefined> {
        return this.provider.getStackOutput(this.distributionIdOutput);
    }

    private errorResponseDocument(): string {
        // Custom error page
        if (this.configuration.errorPage !== undefined) {
            const errorPath = this.configuration.errorPage;
            if (errorPath.startsWith("./") || errorPath.startsWith("../")) {
                throw new ServerlessError(
                    `The 'errorPage' option of the '${this.id}' static website cannot start with './' or '../'. ` +
                        `(it cannot be a relative path).`,
                    "LIFT_INVALID_CONSTRUCT_CONFIGURATION"
                );
            }

            return errorPath;
        }

        /**
         * The default behavior is optimized for SPA: all unknown URLs are served
         * by index.html so that routing can be done client-side.
         */
        return "index.html";
    }

    private createResponseFunction(): cloudfront.Function {
        const securityHeaders: Record<string, { value: string }> = {
            "x-frame-options": { value: "SAMEORIGIN" },
            "x-content-type-options": { value: "nosniff" },
            "x-xss-protection": { value: "1; mode=block" },
            "strict-transport-security": { value: "max-age=63072000" },
        };
        if (this.configuration.security?.allowIframe === true) {
            delete securityHeaders["x-frame-options"];
        }
        const jsonHeaders = JSON.stringify(securityHeaders, undefined, 4);
        /**
         * CloudFront function that manipulates the HTTP responses to add security headers.
         */
        const code = `function handler(event) {
    var response = event.response;
    response.headers = Object.assign({}, ${jsonHeaders}, response.headers);
    return response;
}`;

        return new cloudfront.Function(this, "ResponseFunction", {
            functionName: `${this.provider.stackName}-${this.provider.region}-${this.id}-response`,
            code: cloudfront.FunctionCode.fromInline(code),
        });
    }

    private createRequestFunction(): cloudfront.Function | null {
        let additionalCode = "";

        if (this.configuration.redirectToMainDomain === true) {
            additionalCode += redirectToMainDomain(this.domains);
        }

        if (additionalCode === "") {
            return null;
        }

        const code = `function handler(event) {
    var request = event.request;${additionalCode}
    return request;
}`;

        return new cloudfront.Function(this, "RequestFunction", {
            functionName: `${this.provider.stackName}-${this.provider.region}-${this.id}-request`,
            code: cloudfront.FunctionCode.fromInline(code),
        });
    }
}
