# The shared dev environment the dev-machine scripts run in (machine policy DM1–DM9, README.md, One-time setup).
# Applied once per AWS account by the user; its outputs go into the scripts' settings file (env.example).
# State is in S3 (init.sh creates the bucket), so any machine can plan and apply it.

terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  backend "s3" {
    key          = "brain/dev/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile

  default_tags {
    tags = {
      "brain:infra" = "dev"
      ManagedBy     = "terraform"
    }
  }
}
