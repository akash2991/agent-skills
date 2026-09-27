#!/bin/bash
# init.sh — create the Terraform state bucket if it is missing, then terraform init against it.
#
# Usage: skills/development-setup/terraform/init.sh <aws-profile> [<region>]     (region defaults to ap-southeast-2)
# The bucket is brain-tfstate-<account>-<region>: versioned, encrypted, private. Run once per machine; then
# terraform plan and apply in this directory with terraform.tfvars (terraform.tfvars.example).
set -e
PROFILE="${1:-}"
REGION="${2:-ap-southeast-2}"
[ -n "$PROFILE" ] || { sed -n '4p' "$0" | sed 's/^# //' >&2; exit 2; }
cd "$(dirname "$0")"
export AWS_PROFILE="$PROFILE" AWS_REGION="$REGION" AWS_PAGER=""

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="brain-tfstate-$ACCOUNT-$REGION"

if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "creating state bucket $BUCKET" >&2
  aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
  aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  aws s3api put-bucket-tagging --bucket "$BUCKET" --tagging 'TagSet=[{Key=brain:infra,Value=dev}]'
fi

terraform init -reconfigure -backend-config="bucket=$BUCKET" -backend-config="region=$REGION" -backend-config="profile=$PROFILE"
