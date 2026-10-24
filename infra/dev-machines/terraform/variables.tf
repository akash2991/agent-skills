variable "aws_profile" {
  description = "The local AWS profile Terraform and the cloud scripts run as (AWS_PROFILE in the settings file)."
  type        = string
}

variable "region" {
  description = "The region for every brain machine (CLOUD_REGION in the settings file)."
  type        = string
  default     = "ap-southeast-2"
}

variable "vpc_cidr" {
  description = "The dev VPC's address range; kept clear of the default VPC's 172.31.0.0/16."
  type        = string
  default     = "10.42.0.0/16"
}

variable "availability_zones" {
  description = "One public subnet per zone. The first is CLOUD_SUBNET and holds the home volumes, so it must offer both the dev type and the Mac type (aws ec2 describe-instance-type-offerings)."
  type        = list(string)
  default     = ["ap-southeast-2a", "ap-southeast-2b"]
}

variable "home_volumes" {
  description = "A home volume per developer (DM9): their name and its size in GiB. Its ID goes in that developer's CLOUD_HOME_VOLUME."
  type        = map(number)
  default     = {}

  validation {
    condition     = alltrue([for n, s in var.home_volumes : can(regex("^[a-z0-9-]+$", n)) && s >= 8])
    error_message = "Name each developer in lowercase letters, digits, and hyphens, with a volume of at least 8 GiB."
  }
}

variable "snapshot_days" {
  description = "How many daily snapshots of each home volume are kept."
  type        = number
  default     = 7

  validation {
    condition     = var.snapshot_days >= 1
    error_message = "Keep at least one snapshot."
  }
}

variable "ssh_public_key_path" {
  description = "The public half of the key the scripts SSH with; its private key must be in the SSH agent."
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "key_name" {
  description = "The EC2 key pair's name (CLOUD_KEY_NAME in the settings file)."
  type        = string
  default     = "brain-dev"
}
