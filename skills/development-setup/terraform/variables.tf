variable "aws_profile" {
  description = "The local AWS profile Terraform and the cloud scripts run as (AWS_PROFILE in .env)."
  type        = string
}

variable "region" {
  description = "The region for every brain machine (CLOUD_REGION in .env)."
  type        = string
  default     = "ap-southeast-2"
}

variable "vpc_cidr" {
  description = "The dev VPC's address range; kept clear of the default VPC's 172.31.0.0/16."
  type        = string
  default     = "10.42.0.0/16"
}

variable "availability_zones" {
  description = "One public subnet per zone. The first is CLOUD_SUBNET, so it must offer both the dev type and the Mac type (aws ec2 describe-instance-type-offerings)."
  type        = list(string)
  default     = ["ap-southeast-2a", "ap-southeast-2b"]
}

variable "ssh_cidrs" {
  description = "Addresses allowed to SSH in, each a /32 of a developer's public IP; nothing else is ever opened (DS15)."
  type        = list(string)

  validation {
    condition     = length(var.ssh_cidrs) > 0 && alltrue([for c in var.ssh_cidrs : c != "0.0.0.0/0"])
    error_message = "List at least one developer address, and never 0.0.0.0/0."
  }
}

variable "ssh_public_key_path" {
  description = "The public half of the key the scripts SSH with; its private key must be in the SSH agent."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "key_name" {
  description = "The EC2 key pair's name (CLOUD_KEY_NAME in .env)."
  type        = string
  default     = "brain-dev"
}
