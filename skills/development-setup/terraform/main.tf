data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  account = data.aws_caller_identity.current.account_id
  arn     = "arn:${data.aws_partition.current.partition}"
}

# --- Network: public subnets only. Machines reach the internet through the gateway and are reached only by SSH
# through the Instance Connect Endpoint; nothing is open to the internet, and with no NAT gateway an idle environment
# costs nothing but its home volumes.

resource "aws_vpc" "dev" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "brain-dev" }
}

resource "aws_internet_gateway" "dev" {
  vpc_id = aws_vpc.dev.id
  tags   = { Name = "brain-dev" }
}

resource "aws_subnet" "public" {
  count                   = length(var.availability_zones)
  vpc_id                  = aws_vpc.dev.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  map_public_ip_on_launch = true
  tags                    = { Name = "brain-dev-public-${var.availability_zones[count.index]}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.dev.id
  tags   = { Name = "brain-dev-public" }

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.dev.id
  }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# The default security group of a new VPC allows everything between its members; strip it so only brain-dev applies.
resource "aws_default_security_group" "dev" {
  vpc_id = aws_vpc.dev.id
  tags   = { Name = "brain-dev-default-unused" }
}

# --- Access: SSH through the EC2 Instance Connect Endpoint only, nothing in from the internet (DS15). The endpoint
# authorizes each tunnel with the developer's AWS credentials; services are reached through SSH tunnels.

# The description predates the endpoint and is kept: changing it replaces the group, and its ID is in every project's
# .env as CLOUD_SECURITY_GROUP. The rules below are what it allows.
resource "aws_security_group" "dev" {
  name        = "brain-dev"
  description = "brain dev machines: SSH from developer addresses only"
  vpc_id      = aws_vpc.dev.id
  tags        = { Name = "brain-dev" }
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  security_group_id            = aws_security_group.dev.id
  description                  = "SSH from the Instance Connect Endpoint"
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
  referenced_security_group_id = aws_security_group.eice.id
}

resource "aws_security_group" "eice" {
  name        = "brain-dev-eice"
  description = "brain dev Instance Connect Endpoint: SSH to brain dev machines only"
  vpc_id      = aws_vpc.dev.id
  tags        = { Name = "brain-dev-eice" }
}

resource "aws_vpc_security_group_egress_rule" "eice_ssh" {
  security_group_id            = aws_security_group.eice.id
  description                  = "SSH to brain dev machines"
  ip_protocol                  = "tcp"
  from_port                    = 22
  to_port                      = 22
  referenced_security_group_id = aws_security_group.dev.id
}

resource "aws_ec2_instance_connect_endpoint" "dev" {
  subnet_id          = aws_subnet.public[0].id
  security_group_ids = [aws_security_group.eice.id]
  preserve_client_ip = false
  tags               = { Name = "brain-dev" }
}

resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.dev.id
  description       = "packages, images, git"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_key_pair" "dev" {
  key_name   = var.key_name
  public_key = trimspace(file(pathexpand(var.ssh_public_key_path)))
}

# --- Home volumes (DS18): one per developer, in the first zone (CLOUD_SUBNET's). cloud-up.sh attaches it to that
# developer's machine as /home/ec2-user; it outlives every machine. Daily snapshots, kept for snapshot_days.

resource "aws_ebs_volume" "home" {
  for_each          = var.home_volumes
  availability_zone = var.availability_zones[0]
  size              = each.value
  type              = "gp3"
  encrypted         = true
  tags              = { Name = "brain-home-${each.key}", "brain:home" = each.key, "brain:backup" = "daily" }

  # A developer's files live here; removing one from home_volumes must not delete it.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role" "snapshots" {
  name = "brain-dev-snapshots"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "dlm.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account } }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "snapshots" {
  role       = aws_iam_role.snapshots.name
  policy_arn = "${local.arn}:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole"
}

resource "aws_dlm_lifecycle_policy" "home" {
  description        = "brain home volumes daily"
  execution_role_arn = aws_iam_role.snapshots.arn
  state              = "ENABLED"

  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { "brain:backup" = "daily" }

    schedule {
      name      = "daily"
      copy_tags = true

      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["17:00"]
      }

      retain_rule {
        count = var.snapshot_days
      }
    }
  }
}

# --- The AWS-side deadline (DS13): EventBridge Scheduler assumes this role to terminate a machine or release a Mac
# host, and only one tagged brain=dev.

resource "aws_iam_role" "scheduler" {
  name = "brain-dev-scheduler"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = { StringEquals = { "aws:SourceAccount" = local.account } }
    }]
  })
}

resource "aws_iam_role_policy" "scheduler" {
  name = "terminate-brain-dev"
  role = aws_iam_role.scheduler.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["ec2:TerminateInstances", "ec2:ReleaseHosts"]
      Resource = [
        "${local.arn}:ec2:${var.region}:${local.account}:instance/*",
        "${local.arn}:ec2:${var.region}:${local.account}:dedicated-host/*",
      ]
      Condition = { StringEquals = { "aws:ResourceTag/brain" = "dev" } }
    }]
  })
}

# --- What a project's AWS_PROFILE needs to run the cloud scripts (cloud.md). Attach it to the IAM user or role a
# developer's profile uses; an administrator already has it.

resource "aws_iam_policy" "operator" {
  name        = "brain-dev-operator"
  description = "Run the development-setup cloud scripts against the brain dev environment"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Machines"
        Effect = "Allow"
        Action = [
          "ec2:RunInstances", "ec2:TerminateInstances", "ec2:CreateTags", "ec2:AttachVolume",
          "ec2:AllocateHosts", "ec2:ReleaseHosts", "ec2:Describe*",
        ]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = var.region } }
      },
      {
        Sid      = "Ssh"
        Effect   = "Allow"
        Action   = "ec2-instance-connect:OpenTunnel"
        Resource = aws_ec2_instance_connect_endpoint.dev.arn
      },
      {
        Sid      = "Ami"
        Effect   = "Allow"
        Action   = "ssm:GetParameter"
        Resource = "${local.arn}:ssm:${var.region}::parameter/aws/service/ami-amazon-linux-latest/*"
      },
      {
        Sid    = "Deadlines"
        Effect = "Allow"
        Action = [
          "scheduler:CreateSchedule", "scheduler:UpdateSchedule",
          "scheduler:DeleteSchedule", "scheduler:ListSchedules",
        ]
        Resource = "*"
      },
      {
        Sid      = "PassSchedulerRole"
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = aws_iam_role.scheduler.arn
      },
    ]
  })
}
